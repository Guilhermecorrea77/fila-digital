/* =====================================================================
 * sync.js — leva o estado da fila da recepção até os celulares.
 *
 * - A recepção publica o estado completo da sala, ASSINADO com uma chave
 *   privada que só ela tem (ECDSA P-256, WebCrypto).
 * - Os celulares recebem a chave pública pelo QR code e só aceitam
 *   mensagens com assinatura válida: ninguém consegue "fingir" uma chamada.
 * - Transporte padrão: MQTT sobre WebSocket num broker público, com a
 *   mensagem "retida" (quem entra depois recebe o último estado na hora).
 * - Modo "local": BroadcastChannel + localStorage, para testar com várias
 *   abas no mesmo computador, sem internet.
 *
 * Para produção, basta trocar o transporte (ex.: Supabase Realtime ou um
 * broker próprio) mantendo a mesma interface: publicarEstado / enviarSinal.
 * ===================================================================== */

export const BROKER_PADRAO = 'wss://broker.hivemq.com:8884/mqtt';
const PREFIXO = 'filadigital/v1';

// ---------------- base64url ----------------
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const deB64u = (s) => {
    s = s.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
};
export const textoParaB64u = (t) => b64u(new TextEncoder().encode(t));
export const b64uParaTexto = (s) => new TextDecoder().decode(deB64u(s));

// ---------------- identificadores ----------------
const ALFABETO = 'abcdefghjkmnpqrstuvwxyz23456789';
export function novoId(n = 10) {
    const r = crypto.getRandomValues(new Uint8Array(n));
    return Array.from(r, (x) => ALFABETO[x % ALFABETO.length]).join('');
}
export const novoToken = () => b64u(crypto.getRandomValues(new Uint8Array(12)));
export async function hashToken(tok) {
    const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(tok));
    return Array.from(new Uint8Array(h).slice(0, 8), (x) => x.toString(16).padStart(2, '0')).join('');
}

// ---------------- chaves e assinatura ----------------
const ALG = { name: 'ECDSA', namedCurve: 'P-256' };
const ASS = { name: 'ECDSA', hash: 'SHA-256' };

export async function gerarChaves() {
    const par = await crypto.subtle.generateKey(ALG, true, ['sign', 'verify']);
    const pub = b64u(await crypto.subtle.exportKey('raw', par.publicKey));
    const jwk = await crypto.subtle.exportKey('jwk', par.privateKey);
    return { pub, jwk };
}
export const importarPrivada = (jwk) => crypto.subtle.importKey('jwk', jwk, ALG, false, ['sign']);
export const importarPublica = (pub) => crypto.subtle.importKey('raw', deB64u(pub), ALG, false, ['verify']);

export async function assinar(chavePrivada, texto) {
    return b64u(await crypto.subtle.sign(ASS, chavePrivada, new TextEncoder().encode(texto)));
}
export async function verificar(chavePublica, texto, assinatura) {
    try { return await crypto.subtle.verify(ASS, chavePublica, deB64u(assinatura), new TextEncoder().encode(texto)); } catch (e) { return false; }
}

// ---------------- transportes ----------------
function transporteMQTT(url, salaId, { aoMensagem, aoStatus }) {
    if (!window.mqtt) throw new Error('Biblioteca MQTT não carregada.');
    const tEstado = `${PREFIXO}/${salaId}/estado`;
    const tSinal = `${PREFIXO}/${salaId}/sinal`;
    const cli = window.mqtt.connect(url, {
        clientId: `fd_${novoId(8)}`, clean: true, keepalive: 30, reconnectPeriod: 3000, connectTimeout: 10000,
    });
    aoStatus('conectando');
    cli.on('connect', () => { aoStatus('online'); cli.subscribe([tEstado, tSinal], { qos: 1 }); });
    cli.on('reconnect', () => aoStatus('conectando'));
    cli.on('offline', () => aoStatus('offline'));
    cli.on('close', () => aoStatus('offline'));
    cli.on('error', () => aoStatus('offline'));
    cli.on('message', (topico, msg) => aoMensagem(topico === tEstado ? 'estado' : 'sinal', msg.toString()));
    return {
        publicarEstado: (txt) => new Promise((ok) => cli.publish(tEstado, txt, { qos: 1, retain: true }, () => ok())),
        enviarSinal: (txt) => new Promise((ok) => cli.publish(tSinal, txt, { qos: 1, retain: false }, () => ok())),
        fechar: () => cli.end(true),
    };
}

function transporteLocal(salaId, { aoMensagem, aoStatus }) {
    const canal = new BroadcastChannel(`filadigital-${salaId}`);
    const chave = `fd-retido-${salaId}`;
    canal.onmessage = (ev) => aoMensagem(ev.data.tipo, ev.data.txt);
    setTimeout(() => {
        aoStatus('online');
        try { const r = localStorage.getItem(chave); if (r) aoMensagem('estado', r); } catch (e) { /* nada */ }
    }, 0);
    return {
        publicarEstado: async (txt) => { try { localStorage.setItem(chave, txt); } catch (e) { /* nada */ } canal.postMessage({ tipo: 'estado', txt }); },
        enviarSinal: async (txt) => canal.postMessage({ tipo: 'sinal', txt }),
        fechar: () => canal.close(),
    };
}

/**
 * Conecta a uma sala.
 * opcoes: { salaId, pub, broker, jwk? (só a recepção), aoEstado(estado), aoSinal(obj), aoStatus(s) }
 * Retorna: { publicar(estado), enviarSinal(obj), fechar(), ultimoEstado() }
 */
export async function conectar({ salaId, pub, broker = BROKER_PADRAO, jwk = null, aoEstado = () => {}, aoSinal = () => {}, aoStatus = () => {} }) {
    const chavePub = await importarPublica(pub);
    const chavePriv = jwk ? await importarPrivada(jwk) : null;
    let ultimo = null;
    let fila = Promise.resolve(); // processa mensagens em ordem

    async function receber(tipo, txt) {
        if (tipo === 'sinal') {
            try { const obj = JSON.parse(txt); if (obj && typeof obj === 'object') aoSinal(obj); } catch (e) { /* ignora */ }
            return;
        }
        let env;
        try { env = JSON.parse(txt); } catch (e) { return; }
        if (!env || typeof env.p !== 'string' || typeof env.s !== 'string') return;
        if (!(await verificar(chavePub, env.p, env.s))) { console.warn('[fila] mensagem com assinatura inválida ignorada'); return; }
        let estado;
        try { estado = JSON.parse(env.p); } catch (e) { return; }
        if (!estado?.sala || estado.sala.id !== salaId) return;
        if (ultimo && (estado.rev < ultimo.rev || (estado.rev === ultimo.rev && estado.ts <= ultimo.ts))) return;
        ultimo = estado;
        aoEstado(estado);
    }
    const aoMensagem = (tipo, txt) => { fila = fila.then(() => receber(tipo, txt)); };
    const t = broker === 'local' ? transporteLocal(salaId, { aoMensagem, aoStatus }) : transporteMQTT(broker, salaId, { aoMensagem, aoStatus });

    return {
        async publicar(estado) {
            if (!chavePriv) throw new Error('Somente a recepção pode publicar.');
            const p = JSON.stringify(estado);
            const s = await assinar(chavePriv, p);
            ultimo = estado;
            await t.publicarEstado(JSON.stringify({ p, s }));
        },
        enviarSinal: (obj) => t.enviarSinal(JSON.stringify(obj)),
        fechar: () => t.fechar(),
        ultimoEstado: () => ultimo,
    };
}
