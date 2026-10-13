/* painel.js — tela de TV da sala de espera: mostra e fala as chamadas. */
import * as F from './fila.js';
import { conectar } from './sync.js';
import { $, esc, fmtHora, lerParametros, linkSala, qrSVG, statusConexao, tocarAlerta, falar, liberarAudio, textoChamada } from './ui.js';

const p = lerParametros();
let estado = null;
let ultimaChave = null;
let somAtivo = false;

$('#ativar-som button').addEventListener('click', () => {
    somAtivo = liberarAudio();
    falar(' ');
    $('#ativar-som').hidden = true;
    document.documentElement.requestFullscreen?.().catch(() => {});
});

function render(anunciar) {
    const c = estado.chamadas[0];
    const cat = (id) => estado.categorias.find((k) => k.id === id.replace(/\d+$/, '')) || { nome: '', cor: '#888' };
    if (c) {
        const k = cat(c.id);
        $('#atual').innerHTML = `<span class="rot">Senha chamada</span>
            <span class="cod">${esc(F.formatarCodigo(c.id))}</span>
            <span class="gui">${esc(c.guiche)}</span>
            <span class="cat-chip" style="--cor:${k.cor}">${esc(k.nome)}</span>`;
    } else {
        $('#atual').innerHTML = `<span class="rot">${esc(estado.sala.nome)}</span><span class="cod" style="font-size:clamp(3rem,8vw,7rem)">Aguardando chamadas</span>`;
    }
    $('#ultimas').innerHTML = estado.chamadas.slice(1, 6).map((x) => `
        <div class="chamada"><span class="senha-cod">${esc(F.formatarCodigo(x.id))}</span><span>${esc(x.guiche)} · ${fmtHora(x.ts)}</span></div>`).join('')
        || '<p style="opacity:.6">—</p>';
    if (anunciar && c) {
        const el = $('#atual');
        el.classList.remove('piscar'); void el.offsetWidth; el.classList.add('piscar');
        if (somAtivo) { tocarAlerta(1); setTimeout(() => falar(textoChamada(c.id, c.guiche)), 900); }
    }
}

$('#qr').innerHTML = `${qrSVG(linkSala({ id: p.salaId, pub: p.pub, broker: p.broker }))}
    <div><b>Acompanhe sua senha pelo celular</b>Aponte a câmera para o código e digite a sua senha.</div>`;

if (!p.salaId || !p.pub) {
    $('#atual').innerHTML = '<span class="rot">Link do painel incompleto. Abra pelo botão “Painel TV” da recepção.</span>';
} else {
    conectar({
        salaId: p.salaId, pub: p.pub, broker: p.broker,
        aoEstado: (e) => {
            estado = e;
            const c = e.chamadas[0];
            const chave = c ? `${c.id}|${c.ts}` : null;
            const nova = ultimaChave !== null && chave && chave !== ultimaChave;
            if (ultimaChave === null) ultimaChave = chave || '';
            else if (chave) ultimaChave = chave;
            render(nova);
        },
        aoStatus: (s) => statusConexao($('#conexao'), s),
    });
}
