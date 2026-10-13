/* recepcao.js — tela da recepção: emite senhas, chama, controla atrasos. */
import * as F from './fila.js';
import { conectar, gerarChaves, novoId, novoToken, hashToken, BROKER_PADRAO, textoParaB64u, b64uParaTexto } from './sync.js';
import { $, $$, esc, fmtDuracao, fmtMinutos, fmtHora, linkSala, linkPainel, qrSVG, statusConexao, tocarAlerta } from './ui.js';

const app = $('#app');
const MIN = 60000;

// ---------------- armazenamento local ----------------
const ler = (k, padrao = null) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : padrao; } catch (e) { return padrao; } };
const gravar = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* cheio/bloqueado */ } };

let sala = ler('fd-sala');          // { id, nome, pub, jwk, broker }
let estado = null;
let conexao = null;
let meuGuiche = ler('fd-meu-guiche');
let tokens = {};                    // senha → segredo (para reimprimir o QR pessoal)

// ---------------- link de operador (outro computador) ----------------
function lerLinkOperador() {
    const m = location.hash.match(/^#op=(.+)$/);
    if (!m) return;
    history.replaceState(null, '', location.pathname);
    try {
        const s = JSON.parse(b64uParaTexto(m[1]));
        if (!s.id || !s.pub || !s.jwk) throw new Error('incompleto');
        if (sala && sala.id !== s.id && !confirm(`Este computador já controla a sala "${sala.nome}". Trocar para "${s.nome}"?`)) return;
        sala = s;
        gravar('fd-sala', sala);
    } catch (e) { alert('Link de operador inválido.'); }
}

// ---------------- criação da sala ----------------
function telaCriar() {
    $('#acoes-topo').hidden = true;
    app.innerHTML = `
    <div class="estreita" style="margin:0 auto">
        <section class="card">
            <h1>Criar a fila</h1>
            <p class="mini">Faça isto uma vez, no computador da recepção. Ele vai controlar a fila; os pacientes acompanham pelo celular.</p>
            <form id="form-criar">
                <div class="campo"><label for="c-nome">Nome do local</label>
                    <input type="text" id="c-nome" required maxlength="60" placeholder="Ex.: Pronto Atendimento — Hospital São José"></div>
                <div class="campos">
                    <div class="campo"><label for="c-guiches">Guichês / consultórios</label>
                        <input type="number" id="c-guiches" min="1" max="20" value="2"></div>
                    <div class="campo"><label for="c-tol">Tolerância após chamar (min)</label>
                        <input type="number" id="c-tol" min="1" max="30" value="${F.CONFIG_PADRAO.tolerancia}"></div>
                </div>
                <details class="campo"><summary class="mini">Avançado: servidor de sincronização</summary>
                    <div class="campo" style="margin-top:.75rem"><label for="c-broker">Servidor</label>
                        <select id="c-broker">
                            <option value="${BROKER_PADRAO}">Público gratuito (HiveMQ) — recomendado para testar</option>
                            <option value="local">Só neste computador (abas do navegador, para demonstração)</option>
                            <option value="outro">Outro servidor MQTT (wss://…)</option>
                        </select>
                        <input type="text" id="c-broker-url" placeholder="wss://seu-servidor:8884/mqtt" hidden style="margin-top:.5rem">
                    </div>
                </details>
                <button class="btn btn-pri btn-grande btn-bloco" type="submit">Criar fila</button>
            </form>
        </section>
        <section class="card mini">
            Já tem uma fila em outro computador? Abra lá <b>⚙️ Configurar → Link de operador</b> e cole o link aqui no navegador.
        </section>
    </div>`;
    $('#c-broker').addEventListener('change', (e) => { $('#c-broker-url').hidden = e.target.value !== 'outro'; });
    $('#form-criar').addEventListener('submit', async (e) => {
        e.preventDefault();
        const nome = $('#c-nome').value.trim();
        if (!nome) return;
        let broker = $('#c-broker').value;
        if (broker === 'outro') broker = $('#c-broker-url').value.trim() || BROKER_PADRAO;
        const n = Math.max(1, Math.min(20, Number($('#c-guiches').value) || 1));
        const { pub, jwk } = await gerarChaves();
        sala = { id: novoId(), nome, pub, jwk, broker };
        gravar('fd-sala', sala);
        estado = F.novoEstado({ id: sala.id, nome, cfg: { tolerancia: Number($('#c-tol').value) || 5, guiches: Array.from({ length: n }, (_, i) => `Guichê ${i + 1}`) } });
        salvarEstado();
        iniciar();
    });
}

// ---------------- estado ----------------
const chaveEstado = () => `fd-estado-${sala.id}`;
function salvarEstado() { gravar(chaveEstado(), estado); gravar(`fd-tokens-${sala.id}`, tokens); }

async function aplicar(novo, { som = false } = {}) {
    if (!novo || novo === estado) return;
    estado = novo;
    salvarEstado();
    render();
    if (som) tocarAlerta(1);
    try { await conexao.publicar(estado); } catch (e) { console.error(e); }
}

async function tratarSinal(msg) {
    if (msg?.tipo !== 'a-caminho' || typeof msg.id !== 'string' || typeof msg.tok !== 'string') return;
    const t = estado.tickets.find((x) => x.id === msg.id);
    if (!t || !t.tokH || t.status !== F.STATUS.CHAMADO || t.aCaminho) return;
    if ((await hashToken(msg.tok)) !== t.tokH) return;
    await aplicar(F.registrarACaminho(estado, msg.id));
    aviso(`🚶 ${F.formatarCodigo(msg.id)} avisou que está a caminho (tolerância dobrada).`);
}

let avisoTimer = null;
function aviso(txt) {
    let el = $('#aviso-flutuante');
    if (!el) { el = document.createElement('div'); el.id = 'aviso-flutuante'; el.setAttribute('role', 'status'); el.style.cssText = 'position:fixed;left:50%;bottom:1rem;transform:translateX(-50%);background:var(--titulo);color:var(--card);padding:.75rem 1.1rem;border-radius:10px;box-shadow:var(--sombra);z-index:100;max-width:90vw;font-weight:600'; document.body.appendChild(el); }
    el.textContent = txt; el.hidden = false;
    clearTimeout(avisoTimer); avisoTimer = setTimeout(() => { el.hidden = true; }, 5000);
}

// ---------------- render ----------------
const cat = (id) => estado.categorias.find((c) => c.id === id) || { nome: id, cor: '#888' };
const chip = (id) => { const c = cat(id); return `<span class="cat-chip" style="--cor:${c.cor}">${esc(c.nome)}</span>`; };
const cod = (id) => `<span class="senha-cod">${esc(F.formatarCodigo(id))}</span>`;

function render() {
    const agora = Date.now();
    if (!estado.cfg.guiches.includes(meuGuiche)) meuGuiche = estado.cfg.guiches[0];
    const fila = F.ordem(estado, agora);
    const r = F.resumo(estado, agora);
    const meu = estado.tickets.find((t) => t.status === F.STATUS.CHAMADO && t.guiche === meuGuiche);
    const outros = r.chamados.filter((t) => t.guiche !== meuGuiche);
    const prox = fila[0];

    $('#nome-sala').textContent = estado.sala.nome;
    app.innerHTML = `
    <div class="grade-recepcao">
        <div>
            <section class="card" aria-labelledby="t-emitir">
                <h2 id="t-emitir">Emitir senha</h2>
                <p class="mini">Escolha a categoria após a triagem rápida.</p>
                <div class="emitir-grade">
                    ${estado.categorias.map((c) => `<button type="button" class="btn-cat" data-emitir="${c.id}" style="--cor:${c.cor}">
                        <span class="letra">${esc(c.id)}</span><span><b>${esc(c.nome)}</b><small>${esc(c.exemplos || '')}</small></span></button>`).join('')}
                </div>
            </section>
            <section class="card" aria-labelledby="t-num">
                <h2 id="t-num">Agora</h2>
                <div class="numeros">
                    <div class="numero"><b>${r.aguardando}</b><span>aguardando</span></div>
                    <div class="numero"><b>${r.atendidosHoje}</b><span>atendidos hoje</span></div>
                    <div class="numero"><b>${r.esperaMedia === null ? '—' : fmtMinutos(r.esperaMedia)}</b><span>espera média hoje</span></div>
                    <div class="numero"><b>${fmtMinutos(r.minutosPorAtendimento)}</b><span>entre chamadas</span></div>
                </div>
                <p class="mini" style="margin-top:.75rem">${estado.categorias.map((c) => `${chip(c.id)} ${r.porCat[c.id] || 0}`).join(' &nbsp; ')}</p>
            </section>
        </div>

        <div>
            <section class="card" aria-labelledby="t-chamar">
                <div class="guiche-barra">
                    <div class="campo"><label for="sel-guiche">Você está no</label>
                        <select id="sel-guiche">${estado.cfg.guiches.map((g) => `<option ${g === meuGuiche ? 'selected' : ''}>${esc(g)}</option>`).join('')}</select></div>
                    <button type="button" class="btn btn-pri btn-grande" id="btn-proximo" style="flex:1" ${prox ? '' : 'disabled'}>
                        📢 ${prox ? `Chamar próxima: ${esc(F.formatarCodigo(prox.id))}` : 'Ninguém aguardando'}</button>
                </div>
                <h2 id="t-chamar" class="sr-only">Chamada atual</h2>
                ${meu ? `
                <div class="atual">
                    <div>
                        <div class="atual-cod">${cod(meu.id)}</div>
                        <div class="atual-info">${chip(meu.cat)} chamada ${meu.chamadas}× às ${fmtHora(meu.chamadoEm)}
                            ${meu.aCaminho ? '<span class="tag tag-alerta">🚶 a caminho</span>' : ''}</div>
                        <div class="atual-info">Tolerância: <span class="contagem" data-limite="${meu.chamadoEm + estado.cfg.tolerancia * MIN * (meu.aCaminho ? 2 : 1)}"></span></div>
                    </div>
                    <div class="linha-btns">
                        <button type="button" class="btn" data-rechamar="${meu.id}">🔁 Chamar de novo</button>
                        <button type="button" class="btn btn-ok" data-concluir="${meu.id}">✓ Compareceu</button>
                        <button type="button" class="btn btn-perigo" data-ausente="${meu.id}">Não compareceu</button>
                    </div>
                </div>` : '<p class="mini" style="margin:.75rem 0 0">Nenhuma senha chamada neste guichê.</p>'}
            </section>

            <section class="card" aria-labelledby="t-fila">
                <div class="card-topo"><h2 id="t-fila">Fila (${fila.length})</h2><span class="mini">ordem de chamada</span></div>
                ${fila.length ? `<ol class="lista">${fila.map((t, i) => `
                    <li><span class="pos">${i + 1}º</span>${cod(t.id)}${chip(t.cat)}
                        ${t.reinserido ? '<span class="tag">voltou</span>' : ''}
                        <span class="espera" data-desde="${t.emitido}"></span>
                        <span class="acoes-li"><button type="button" class="btn btn-peq" data-chamar="${t.id}" title="Chamar esta senha agora">Chamar</button>
                        <button type="button" class="btn btn-peq btn-perigo" data-cancelar="${t.id}" aria-label="Cancelar ${esc(t.id)}">✕</button></span></li>`).join('')}</ol>`
                : '<p class="vazio">Fila vazia. 🎉</p>'}
            </section>

            ${outros.length ? `<section class="card"><h2>Em outros guichês</h2><ul class="lista">${outros.map((t) => `
                <li>${cod(t.id)}${chip(t.cat)}<span class="mini">${esc(t.guiche)}</span>${t.aCaminho ? '<span class="tag tag-alerta">🚶 a caminho</span>' : ''}
                    <span class="espera contagem" data-limite="${t.chamadoEm + estado.cfg.tolerancia * MIN * (t.aCaminho ? 2 : 1)}"></span></li>`).join('')}</ul></section>` : ''}

            ${r.ausentes.length ? `<section class="card"><div class="card-topo"><h2>Não compareceram</h2><span class="mini">podem voltar por ${estado.cfg.graca} min</span></div>
                <ul class="lista">${r.ausentes.map((t) => `
                <li>${cod(t.id)}${chip(t.cat)}<span class="mini">até ${fmtHora(t.ausenteEm + estado.cfg.graca * MIN)}</span>
                    <span class="acoes-li" style="margin-left:auto"><button type="button" class="btn btn-peq" data-reinserir="${t.id}">↩️ Voltou</button>
                    <button type="button" class="btn btn-peq btn-perigo" data-cancelar="${t.id}" aria-label="Cancelar ${esc(t.id)}">✕</button></span></li>`).join('')}</ul>
                <p class="mini">Quem volta entra depois das próximas ${estado.cfg.penalidade} pessoas.</p></section>` : ''}

            ${estado.chamadas.length ? `<section class="card"><h2>Últimas chamadas</h2><ul class="lista">${estado.chamadas.slice(0, 6).map((c) => `
                <li>${cod(c.id)}<span class="mini">${esc(c.guiche)}${c.n > 1 ? ` · ${c.n}ª chamada` : ''}</span><span class="espera">${fmtHora(c.ts)}</span></li>`).join('')}</ul></section>` : ''}
        </div>
    </div>`;
    tick();
}

/** Atualiza só os relógios, a cada segundo. */
function tick() {
    const agora = Date.now();
    $$('[data-limite]').forEach((el) => {
        const rest = Number(el.dataset.limite) - agora;
        el.textContent = rest > 0 ? `${fmtDuracao(rest)} restantes` : `esgotada há ${fmtDuracao(-rest)}`;
        el.classList.toggle('estourou', rest <= 0);
    });
    $$('[data-desde]').forEach((el) => { el.textContent = `esperando ${fmtMinutos((agora - Number(el.dataset.desde)) / MIN)}`; });
}

// ---------------- ações ----------------
app.addEventListener('change', (e) => {
    if (e.target.id === 'sel-guiche') { meuGuiche = e.target.value; gravar('fd-meu-guiche', meuGuiche); render(); }
});
app.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const d = b.dataset;
    if (d.emitir) return emitirSenha(d.emitir);
    if (b.id === 'btn-proximo') return aplicar(F.chamarProximo(estado, meuGuiche).estado, { som: true });
    if (d.chamar) return aplicar(F.chamarProximo(estado, meuGuiche, { id: d.chamar }).estado, { som: true });
    if (d.rechamar) return aplicar(F.rechamar(estado, d.rechamar), { som: true });
    if (d.concluir) return aplicar(F.concluir(estado, d.concluir));
    if (d.ausente) return aplicar(F.marcarAusente(estado, d.ausente));
    if (d.reinserir) {
        const r = F.reinserir(estado, d.reinserir);
        if (!r.ok) return aviso(r.motivo);
        await aplicar(r.estado);
        return aviso(`${F.formatarCodigo(d.reinserir)} voltou para a fila.`);
    }
    if (d.cancelar) {
        if (confirm(`Cancelar a senha ${F.formatarCodigo(d.cancelar)}?`)) return aplicar(F.cancelar(estado, d.cancelar));
    }
});

async function emitirSenha(catId) {
    const tok = novoToken();
    const { estado: novo, ticket } = F.emitir(estado, catId, { tokH: await hashToken(tok) });
    tokens[ticket.id] = tok;
    // guarda só os segredos das senhas que ainda existem
    const vivos = new Set(novo.tickets.map((t) => t.id));
    tokens = Object.fromEntries(Object.entries(tokens).filter(([k]) => vivos.has(k)));
    await aplicar(novo);
    mostrarBilhete(ticket);
}

function htmlBilhete(ticket, paraImprimir = false) {
    const link = linkSala(sala, { t: ticket.id, x: tokens[ticket.id] });
    const c = cat(ticket.cat);
    return `
        <p class="sala-nome">${esc(estado.sala.nome)}</p>
        ${paraImprimir ? '' : '<h2 id="dlg-senha-titulo" class="sr-only">Senha emitida</h2>'}
        <p class="bil-cod senha-cod">${esc(F.formatarCodigo(ticket.id))}</p>
        <p><span class="cat-chip" style="--cor:${c.cor}">${esc(c.nome)}</span> · ${fmtHora(ticket.emitido)}</p>
        ${qrSVG(link)}
        <p class="bil-inst">Aponte a câmera do celular para o QR code e acompanhe a sua vez. Você será avisado quando for chamado.</p>
        <p class="bil-inst">Se os sintomas piorarem, avise a recepção imediatamente.</p>
        ${paraImprimir ? '' : `<div class="copiavel" style="margin-top:.75rem"><label for="lnk-senha" class="sr-only">Link da senha</label>
            <input type="text" id="lnk-senha" readonly value="${esc(link)}"><button type="button" class="btn btn-peq" data-copiar="lnk-senha">Copiar</button></div>
            <p class="mini" style="margin-top:.35rem">Sem papel? Copie o link e envie para o celular do paciente.</p>`}`;
}

function mostrarBilhete(ticket) {
    $('#dlg-senha-corpo').innerHTML = htmlBilhete(ticket);
    $('#dlg-senha-imprimir').onclick = () => imprimir(`<div class="bilhete-imp">${htmlBilhete(ticket, true)}</div>`);
    $('#dlg-senha').showModal();
}
$('#dlg-senha-fechar').addEventListener('click', () => $('#dlg-senha').close());

function imprimir(html) {
    const area = $('#area-impressao');
    area.innerHTML = html;
    setTimeout(() => { window.print(); setTimeout(() => { area.innerHTML = ''; }, 500); }, 50);
}

// ---------------- QR da sala / links ----------------
function linkOperador() {
    return `${location.href.replace(/[#?].*$/, '')}#op=${textoParaB64u(JSON.stringify(sala))}`;
}
$('#btn-qr-sala').addEventListener('click', () => {
    const link = linkSala(sala);
    $('#dlg-sala-corpo').innerHTML = `
        <h2 id="dlg-sala-titulo">QR code da sala</h2>
        <p class="mini">Imprima e cole na sala de espera. Quem escanear vê as chamadas ao vivo e pode digitar a própria senha.</p>
        <div class="links-sala">${qrSVG(link)}
            <div style="flex:1;min-width:200px">
                <label for="lnk-sala">Link da sala</label>
                <div class="copiavel"><input type="text" id="lnk-sala" readonly value="${esc(link)}"><button type="button" class="btn btn-peq" data-copiar="lnk-sala">Copiar</button></div>
                <p class="mini" style="margin-top:.5rem"><a href="${esc(link)}" target="_blank" rel="noopener">Abrir como paciente ↗</a></p>
            </div>
        </div>`;
    $('#dlg-sala-imprimir').onclick = () => imprimir(`<div class="cartaz"><h1>${esc(estado.sala.nome)}</h1>
        <p><b>Acompanhe a sua senha pelo celular</b></p>${qrSVG(link)}
        <p>1. Abra a câmera do celular · 2. Aponte para o código · 3. Toque no link</p>
        <p style="font-size:12pt">Não precisa instalar nada. Mantenha a página aberta para ser avisado.</p></div>`);
    $('#dlg-sala').showModal();
});
document.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-copiar]');
    if (b) {
        const inp = document.getElementById(b.dataset.copiar);
        inp.select();
        try { await navigator.clipboard.writeText(inp.value); b.textContent = 'Copiado!'; } catch (err) { document.execCommand('copy'); }
        setTimeout(() => { b.textContent = 'Copiar'; }, 1500);
    }
    if (e.target.closest('[data-fechar]')) e.target.closest('dialog')?.close();
});

// ---------------- configuração ----------------
$('#btn-config').addEventListener('click', () => {
    const c = estado.cfg;
    $('#dlg-config-corpo').innerHTML = `
        <h2 id="dlg-config-titulo">Configurar</h2>
        <div class="campo"><label for="f-nome">Nome do local</label><input type="text" id="f-nome" value="${esc(estado.sala.nome)}" maxlength="60"></div>
        <div class="campo"><label for="f-guiches">Guichês / consultórios (separe por vírgula)</label><input type="text" id="f-guiches" value="${esc(c.guiches.join(', '))}"></div>
        <div class="campos">
            <div class="campo"><label for="f-tol">Tolerância (min)</label><input type="number" id="f-tol" min="1" max="60" value="${c.tolerancia}"></div>
            <div class="campo"><label for="f-graca">Pode voltar até (min)</label><input type="number" id="f-graca" min="0" max="240" value="${c.graca}"></div>
            <div class="campo"><label for="f-pen">Ao voltar, entra após</label><input type="number" id="f-pen" min="0" max="20" value="${c.penalidade}"></div>
            <div class="campo"><label for="f-tm">Tempo médio inicial (min)</label><input type="number" id="f-tm" min="1" max="120" value="${c.tempoMedio}"></div>
        </div>
        <h3>Prioridades (bônus em minutos)</h3>
        <p class="mini">Quanto maior o bônus, mais à frente a pessoa entra. Categorias "sempre primeiro" passam na frente de todas.</p>
        <div class="campos">${estado.categorias.map((k) => `<div class="campo"><label for="f-b-${k.id}">${esc(k.nome)}</label>
            ${k.topo ? '<p class="mini">sempre primeiro</p>' : `<input type="number" id="f-b-${k.id}" min="0" max="240" value="${k.bonus}">`}</div>`).join('')}</div>
        <h3>Outro computador</h3>
        <p class="mini">Para controlar a mesma fila em outro computador (ex.: um consultório), abra este link nele. <b>Ele dá controle total da fila — não compartilhe com pacientes.</b></p>
        <div class="copiavel campo"><input type="text" id="lnk-op" readonly value="${esc(linkOperador())}"><button type="button" class="btn btn-peq" data-copiar="lnk-op">Copiar</button></div>
        <h3>Zona de cuidado</h3>
        <div class="linha-btns">
            <button type="button" class="btn btn-perigo" id="btn-novo-dia">Novo dia (zerar senhas)</button>
            <button type="button" class="btn btn-perigo" id="btn-sair">Desconectar este computador</button>
        </div>`;
    $('#btn-novo-dia').onclick = async () => {
        if (!confirm('Zerar todas as senhas e começar do 001? Quem está na fila deixará de ser acompanhado.')) return;
        $('#dlg-config').close();
        await aplicar(F.novoDia(estado));
    };
    $('#btn-sair').onclick = () => {
        if (!confirm('Este computador deixará de controlar a fila. Para voltar, use o link de operador. Continuar?')) return;
        localStorage.removeItem('fd-sala');
        location.reload();
    };
    $('#dlg-config').showModal();
});
$('#form-config').addEventListener('submit', async (e) => {
    e.preventDefault();
    const guiches = $('#f-guiches').value.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 20);
    const num = (id, padrao) => { const v = Number($(id).value); return Number.isFinite(v) && v >= 0 ? v : padrao; };
    let novo = F.atualizarConfig(estado, {
        guiches: guiches.length ? guiches : estado.cfg.guiches,
        tolerancia: num('#f-tol', 5) || 5, graca: num('#f-graca', 30), penalidade: num('#f-pen', 2), tempoMedio: num('#f-tm', 8) || 8,
    });
    novo.categorias = novo.categorias.map((k) => (k.topo ? k : { ...k, bonus: num(`#f-b-${k.id}`, k.bonus) }));
    const nome = $('#f-nome').value.trim();
    if (nome) { novo.sala.nome = nome; sala.nome = nome; gravar('fd-sala', sala); }
    $('#dlg-config').close();
    await aplicar(novo);
});

// ---------------- início ----------------
async function iniciar() {
    estado = ler(chaveEstado()) || F.novoEstado({ id: sala.id, nome: sala.nome });
    tokens = ler(`fd-tokens-${sala.id}`, {});
    $('#acoes-topo').hidden = false;
    $('#btn-painel').href = linkPainel(sala);
    render();

    let publicouInicial = false;
    conexao = await conectar({
        salaId: sala.id, pub: sala.pub, jwk: sala.jwk, broker: sala.broker || BROKER_PADRAO,
        aoEstado: (e) => {
            // Outro computador de operador mudou a fila: adota a versão mais nova.
            if (e.rev > estado.rev || (e.rev === estado.rev && e.ts > estado.ts)) {
                const chamouAgora = e.chamadas[0] && (!estado.chamadas[0] || e.chamadas[0].ts !== estado.chamadas[0].ts);
                estado = e; salvarEstado(); render();
                if (chamouAgora) tocarAlerta(1);
            }
        },
        aoSinal: tratarSinal,
        aoStatus: (s) => {
            statusConexao($('#conexao'), s);
            if (s === 'online' && !publicouInicial) {
                publicouInicial = true;
                // Espera a mensagem retida chegar; se a nossa for a mais nova, publica.
                setTimeout(() => {
                    const remoto = conexao.ultimoEstado();
                    if (!remoto || remoto === estado || remoto.rev <= estado.rev) conexao.publicar(estado);
                }, 1500);
            }
        },
    });
    // "Batimento": republica a cada minuto para os celulares saberem que está tudo no ar.
    setInterval(() => { estado = { ...estado, ts: Date.now() }; salvarEstado(); conexao.publicar(estado).catch(() => {}); }, 60000);
    setInterval(tick, 1000);
    setInterval(render, 30000);
    window.__fila = { get estado() { return estado; }, sala }; // para testes
}

lerLinkOperador();
if (sala) iniciar(); else telaCriar();
