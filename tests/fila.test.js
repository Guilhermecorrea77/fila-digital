import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as F from '../js/fila.js';

const T0 = new Date(2026, 9, 13, 8, 0, 0).getTime();
const min = (n) => T0 + n * 60000;
const novo = () => F.novoEstado({ id: 'sala1', nome: 'PA Teste', agora: T0 });

function emitirVarios(e, lista) {
    for (const [cat, m] of lista) e = F.emitir(e, cat, { agora: min(m) }).estado;
    return e;
}

test('códigos sequenciais por categoria', () => {
    let e = novo();
    e = emitirVarios(e, [['N', 0], ['N', 1], ['P', 2]]);
    assert.deepEqual(e.tickets.map((t) => t.id), ['N001', 'N002', 'P001']);
    assert.equal(e.rev, 3);
});

test('urgência sempre primeiro; prioritário passa na frente de quem chegou pouco antes', () => {
    let e = novo();
    e = emitirVarios(e, [['N', 0], ['N', 5], ['P', 10], ['U', 11]]);
    // aos 11 min: N001=11, N002=6, P001=1+20=21 → U001 (topo), P001, N001, N002
    assert.deepEqual(F.ordem(e, min(11)).map((t) => t.id), ['U001', 'P001', 'N001', 'N002']);
});

test('quem espera muito também sobe (sem fila esquecida)', () => {
    let e = novo();
    e = emitirVarios(e, [['N', 0], ['P', 25]]);
    // N001 tem 25 pontos; P001 tem 0+20 = 20 → N001 primeiro
    assert.equal(F.ordem(e, min(25))[0].id, 'N001');
});

test('80+ antes de prioritário que chegou junto', () => {
    let e = emitirVarios(novo(), [['P', 0], ['S', 0]]);
    assert.equal(F.ordem(e, min(1))[0].id, 'S001');
});

test('chamar próximo conclui o atendimento anterior do mesmo guichê', () => {
    let e = emitirVarios(novo(), [['N', 0], ['N', 1]]);
    e = F.chamarProximo(e, 'Guichê 1', { agora: min(2) }).estado;
    assert.equal(e.tickets[0].status, 'chamado');
    e = F.chamarProximo(e, 'Guichê 1', { agora: min(10) }).estado;
    assert.equal(e.tickets[0].status, 'concluido');
    assert.equal(e.tickets[1].status, 'chamado');
    assert.equal(e.chamadas[0].id, 'N002');
});

test('guichês diferentes não se atrapalham', () => {
    let e = emitirVarios(novo(), [['N', 0], ['N', 1]]);
    e = F.chamarProximo(e, 'Guichê 1', { agora: min(2) }).estado;
    e = F.chamarProximo(e, 'Guichê 2', { agora: min(3) }).estado;
    assert.deepEqual(e.tickets.map((t) => [t.status, t.guiche]), [['chamado', 'Guichê 1'], ['chamado', 'Guichê 2']]);
});

test('fila vazia: chamar próximo não muda nada', () => {
    const e = novo();
    const r = F.chamarProximo(e, 'Guichê 1', { agora: min(1) });
    assert.equal(r.ticket, null);
    assert.equal(r.estado, e);
});

test('tolerância: contagem e "estou a caminho" dobra o prazo', () => {
    let e = emitirVarios(novo(), [['N', 0]]);
    e = F.chamarProximo(e, 'Guichê 1', { agora: min(1) }).estado;
    let s = F.situacao(e, 'N001', min(3));
    assert.equal(s.status, 'chamado');
    assert.equal(s.restanteMs, 3 * 60000);
    e = F.registrarACaminho(e, 'N001', { agora: min(3) });
    s = F.situacao(e, 'N001', min(3));
    assert.equal(s.restanteMs, 8 * 60000);
});

test('ausente volta dentro da graça e entra depois de 2 pessoas', () => {
    let e = emitirVarios(novo(), [['N', 0], ['N', 1], ['N', 2], ['N', 3], ['N', 4]]);
    e = F.chamarProximo(e, 'Guichê 1', { agora: min(5) }).estado; // N001
    e = F.marcarAusente(e, 'N001', { agora: min(11) });
    const r = F.reinserir(e, 'N001', { agora: min(20) });
    assert.ok(r.ok);
    assert.deepEqual(F.ordem(r.estado, min(20)).map((t) => t.id), ['N002', 'N003', 'N001', 'N004', 'N005']);
    // a posição se mantém com o passar do tempo
    assert.deepEqual(F.ordem(r.estado, min(90)).map((t) => t.id), ['N002', 'N003', 'N001', 'N004', 'N005']);
    // e uma prioridade nova ainda pode passar na frente
    const e2 = F.emitir(r.estado, 'U', { agora: min(21) }).estado;
    assert.equal(F.ordem(e2, min(21))[0].id, 'U001');
});

test('ausente fora do prazo não volta', () => {
    let e = emitirVarios(novo(), [['N', 0]]);
    e = F.chamarProximo(e, 'Guichê 1', { agora: min(1) }).estado;
    e = F.marcarAusente(e, 'N001', { agora: min(7) });
    const r = F.reinserir(e, 'N001', { agora: min(40) });
    assert.equal(r.ok, false);
});

test('reinserir com fila curta coloca no fim', () => {
    let e = emitirVarios(novo(), [['N', 0], ['N', 1]]);
    e = F.chamarProximo(e, 'Guichê 1', { agora: min(2) }).estado;
    e = F.marcarAusente(e, 'N001', { agora: min(8) });
    const r = F.reinserir(e, 'N001', { agora: min(9) });
    assert.deepEqual(F.ordem(r.estado, min(9)).map((t) => t.id), ['N002', 'N001']);
});

test('posição e estimativa', () => {
    let e = emitirVarios(novo(), [['N', 0], ['N', 1], ['N', 2]]);
    const s = F.situacao(e, 'N003', min(3));
    assert.equal(s.posicao, 3);
    assert.equal(s.naFrente, 2);
    // sem histórico: 8 min / 2 guichês = 4 min por pessoa → 8 min → faixa 5..15
    assert.deepEqual(s.estimativa, { min: 5, max: 15 });
});

test('estimativa usa o ritmo real quando há chamadas', () => {
    let e = novo();
    for (let i = 0; i < 6; i++) e = F.emitir(e, 'N', { agora: min(i) }).estado;
    for (let i = 0; i < 5; i++) e = F.chamarProximo(e, 'Guichê 1', { agora: min(10 + i * 3) }).estado;
    assert.equal(F.minutosPorAtendimento(e, min(25)), 3);
});

test('novo dia zera a numeração', () => {
    let e = emitirVarios(novo(), [['N', 0]]);
    const amanha = T0 + 24 * 3600000;
    e = F.emitir(e, 'N', { agora: amanha }).estado;
    assert.equal(e.tickets[e.tickets.length - 1].id, 'N001');
});

test('resumo', () => {
    let e = emitirVarios(novo(), [['N', 0], ['P', 1], ['P', 2]]);
    e = F.chamarProximo(e, 'Guichê 1', { agora: min(3) }).estado;
    const r = F.resumo(e, min(3));
    assert.equal(r.aguardando, 2);
    assert.deepEqual(r.porCat, { U: 0, S: 0, P: 1, N: 1 });
    assert.equal(r.chamados.length, 1);
});
