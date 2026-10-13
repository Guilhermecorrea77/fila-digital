/* ui.js — utilidades compartilhadas pelas telas. */
import { BROKER_PADRAO } from './sync.js';

export const $ = (sel, raiz = document) => raiz.querySelector(sel);
export const $$ = (sel, raiz = document) => [...raiz.querySelectorAll(sel)];
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function fmtDuracao(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    const m = Math.floor(s / 60);
    return `${m}:${String(s % 60).padStart(2, '0')}`;
}
export function fmtMinutos(min) {
    if (min < 1) return 'menos de 1 min';
    if (min < 60) return `${Math.round(min)} min`;
    const h = Math.floor(min / 60), m = Math.round(min % 60);
    return m ? `${h} h ${m} min` : `${h} h`;
}
export const fmtHora = (ts) => new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

// ---------------- links ----------------
const base = () => location.href.replace(/[#?].*$/, '').replace(/[^/]*$/, '');
function params(sala, extra = {}) {
    const p = new URLSearchParams({ s: sala.id, k: sala.pub });
    if (sala.broker && sala.broker !== BROKER_PADRAO) p.set('b', sala.broker);
    for (const [k, v] of Object.entries(extra)) if (v) p.set(k, v);
    return p.toString();
}
export const linkSala = (sala, extra) => `${base()}sala.html?${params(sala, extra)}`;
export const linkPainel = (sala) => `${base()}painel.html?${params(sala)}`;

/** Lê sala, chave e (opcional) senha da URL da página do paciente/painel. */
export function lerParametros() {
    const q = new URLSearchParams(location.search);
    return { salaId: q.get('s'), pub: q.get('k'), broker: q.get('b') || BROKER_PADRAO, ticket: (q.get('t') || '').toUpperCase(), token: q.get('x') };
}

// ---------------- QR code (qrcode-generator, em vendor/) ----------------
export function qrSVG(texto, { margem = 2 } = {}) {
    const qr = window.qrcode(0, 'M');
    qr.addData(texto);
    qr.make();
    const n = qr.getModuleCount();
    let d = '';
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (qr.isDark(y, x)) d += `M${x + margem} ${y + margem}h1v1h-1z`;
    const t = n + margem * 2;
    return `<svg class="qr" viewBox="0 0 ${t} ${t}" shape-rendering="crispEdges" role="img" aria-label="QR code"><rect width="${t}" height="${t}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}

// ---------------- som, voz e vibração ----------------
let audioCtx = null;
export function liberarAudio() {
    try {
        audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
        if (audioCtx.state === 'suspended') audioCtx.resume();
        return true;
    } catch (e) { return false; }
}
export function tocarAlerta(vezes = 2) {
    if (!liberarAudio()) return;
    const t0 = audioCtx.currentTime;
    for (let i = 0; i < vezes; i++) {
        [[880, 0], [1175, 0.18]].forEach(([f, dt]) => {
            const o = audioCtx.createOscillator(), g = audioCtx.createGain();
            o.type = 'sine'; o.frequency.value = f;
            const ini = t0 + i * 0.6 + dt;
            g.gain.setValueAtTime(0.0001, ini);
            g.gain.exponentialRampToValueAtTime(0.35, ini + 0.02);
            g.gain.exponentialRampToValueAtTime(0.0001, ini + 0.35);
            o.connect(g).connect(audioCtx.destination);
            o.start(ini); o.stop(ini + 0.4);
        });
    }
}
export function falar(texto) {
    try {
        if (!('speechSynthesis' in window)) return;
        const u = new SpeechSynthesisUtterance(texto);
        u.lang = 'pt-BR'; u.rate = 0.95;
        const voz = speechSynthesis.getVoices().find((v) => v.lang?.toLowerCase().startsWith('pt'));
        if (voz) u.voice = voz;
        speechSynthesis.cancel();
        speechSynthesis.speak(u);
    } catch (e) { /* sem voz */ }
}
export const vibrar = (padrao = [300, 120, 300, 120, 600]) => { try { navigator.vibrate?.(padrao); } catch (e) { /* nada */ } };

/** "Senha P 012" → leitura natural: "Senha P, zero, um, dois" vira "P 12". */
export const textoChamada = (id, guiche) => `Senha ${id.replace(/^([A-Z]+)0*(\d+)$/, '$1, $2')}. ${guiche}.`;

export function statusConexao(el, s) {
    const mapa = { online: ['🟢', 'Ao vivo'], conectando: ['🟡', 'Conectando…'], offline: ['🔴', 'Sem conexão — tentando de novo'] };
    const [ic, tx] = mapa[s] || mapa.conectando;
    el.innerHTML = `<span aria-hidden="true">${ic}</span> ${tx}`;
    el.dataset.status = s;
}
