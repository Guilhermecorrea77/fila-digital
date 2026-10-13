# 🎫 Fila Digital

**Pegue a senha e espere onde quiser.** A recepção emite a senha com prioridade, o paciente escaneia um QR code e acompanha a fila pelo celular, e é avisado (som + vibração) quando for chamado. Menos aglomeração na sala de espera e mais movimento no comércio ao redor.

**Acesse:** https://guilhermecorrea77.github.io/fila-digital/

| Página | Para quem | Link |
|---|---|---|
| Início | todos | [`/`](https://guilhermecorrea77.github.io/fila-digital/) |
| Recepção | quem emite e chama as senhas | [`recepcao.html`](https://guilhermecorrea77.github.io/fila-digital/recepcao.html) |
| Paciente | celular, aberto pelo QR code | `sala.html?s=…&k=…` |
| Painel TV | tela da sala de espera | `painel.html?s=…&k=…` |

---

## ✨ O que o MVP faz

### Recepção
- **Cria a fila** em 1 minuto (nome do local, número de guichês, tolerância).
- **Emite senhas por categoria** após uma triagem simples:
  | Letra | Categoria | Regra |
  |---|---|---|
  | **U** | Urgência (queimadura, dor forte, falta de ar…) | sempre primeiro |
  | **S** | Idoso 80+ | bônus de 30 min (Lei 13.466/2017) |
  | **P** | Prioritário (gestante, 60+, lactante, criança de colo, PcD/TEA) | bônus de 20 min |
  | **N** | Geral | — |
- Cada senha sai com um **QR code pessoal** (imprimir ou copiar o link e mandar pelo WhatsApp).
- **Chamar próxima** por guichê, **chamar de novo**, **compareceu** e **não compareceu**.
- **Atrasos pequenos:** contagem da tolerância; quem não aparece fica em “não compareceram” e, se voltar dentro do prazo, entra de novo **depois das próximas 2 pessoas**.
- **Cartaz com o QR da sala** para imprimir, **link do painel** e **link de operador** para controlar a mesma fila em outro computador.
- Números do dia: aguardando, atendidos, espera média e ritmo de chamadas.
- Tudo configurável: guichês, tolerância, prazo de retorno, penalidade e bônus de cada prioridade.

### Paciente (celular)
- Abre pelo **QR code** (câmera do celular ou o leitor da própria página).
- Vê **quantas pessoas estão na frente** e a **estimativa de tempo**, que se ajusta ao ritmo real das chamadas.
- **Avisos:** som, vibração, notificação e voz quando for chamado, e um aviso quando faltarem 3.
- Botão **“Estou a caminho”**: avisa a recepção e dobra a tolerância.
- Lembrete fixo: *se os sintomas piorarem, avise a recepção*.

### Painel de TV
- Senha e guichê em letras grandes, **chamada falada** (“Senha P, 12. Guichê 2.”) e as últimas chamadas.
- QR code no canto para quem quiser acompanhar pelo celular.

---

## ⚖️ Como a ordem é decidida

1. **Urgência** (categorias “sempre primeiro”) passa na frente de todos.
2. Para os demais: `pontos = minutos esperando + bônus da categoria`, e quem tem mais pontos é chamado primeiro.

Assim as prioridades legais passam na frente, mas **quem espera muito também sobe**: ninguém fica esquecido. Como todos ganham 1 ponto por minuto, a ordem entre quem já está na fila só muda quando chega alguém com prioridade.

> ⚠️ Isto **não substitui a classificação de risco** (ex.: Protocolo de Manchester) feita pela enfermagem. É uma ferramenta de organização da espera; a categoria é escolhida pela equipe, nunca pelo paciente.

---

## 🔐 Como funciona por dentro

```
 Recepção ──(estado assinado)──▶ servidor MQTT ──▶ celulares e painel
    ▲                                          │
    └──────────("estou a caminho")─────────────┘
```

- **Sem servidor próprio:** funciona no GitHub Pages. O computador da recepção guarda a fila e a publica num **broker MQTT** (por padrão, o público e gratuito da HiveMQ). A mensagem fica “retida”, então quem abre o link recebe o estado atual na hora.
- **À prova de falsificação:** a recepção assina cada mensagem com uma chave **ECDSA P-256** (WebCrypto). Os celulares recebem a chave pública dentro do QR code e **ignoram qualquer mensagem sem assinatura válida**.
- **“Estou a caminho”** só é aceito com o segredo que vai no QR pessoal de cada senha.
- **Privacidade (LGPD):** não trafega nome, CPF nem dado pessoal, só o código da senha e a categoria.
- **Modo demonstração:** em *Avançado → Só neste computador*, a fila funciona entre abas do mesmo navegador, sem internet.

### Limitações conhecidas do MVP
- O broker público é ótimo para testar, mas **não tem garantia de disponibilidade**. Para uso real, use um broker próprio (campo “Outro servidor”) ou troque o transporte em `js/sync.js` (ex.: Supabase Realtime). A interface já está isolada para isso.
- Com dois computadores de operador, cliques **exatamente simultâneos** podem conflitar (vale a última versão).
- Navegadores de celular podem pausar páginas com a tela bloqueada. O app pede para manter a tela ligada, mas o aviso com o celular bloqueado precisaria de *Web Push* (requer servidor).

---

## 🗺️ Próximos passos

1. **Anamnese digital:** o paciente responde perguntas simples enquanto espera, e o médico de plantão recebe um **relatório resumido** na hora do atendimento (com consentimento, dados protegidos e servidor próprio).
2. **Servidor próprio** (Supabase/Firebase ou broker MQTT dedicado), com login da equipe e histórico.
3. **Web Push** para avisar com o celular bloqueado, e **SMS/WhatsApp** opcional.
4. **Vários setores** (exames, farmácia, retornos) e outros segmentos: **comércio, cartórios, restaurantes, barbearias, órgãos públicos**.
5. **Relatórios de gestão:** tempo médio por categoria, horários de pico e taxa de não comparecimento.
6. **Totem de autoatendimento** para emitir senha das categorias que não exigem triagem.
7. **Acessibilidade:** leitura em voz alta na página do paciente e opção de idioma.

---

## 💻 Desenvolvimento

HTML, CSS e JavaScript puro (módulos ES), sem etapa de build.

```bash
git clone https://github.com/Guilhermecorrea77/fila-digital.git
cd fila-digital
python3 -m http.server 8080      # abra http://localhost:8080
npm test                          # testes das regras da fila (Node 18+)
```

```
/
├── index.html        # Início
├── recepcao.html     # Recepção (emitir e chamar)
├── sala.html         # Paciente (celular)
├── painel.html       # TV da sala de espera
├── style.css
├── js/
│   ├── fila.js       # Regras da fila: prioridades, tolerância, estimativa (testado)
│   ├── sync.js       # Sincronização assinada (MQTT / modo local)
│   ├── ui.js         # QR code, som, voz, links
│   ├── scanner.js    # Leitor de QR pela câmera
│   ├── recepcao.js · sala.js · painel.js
├── vendor/           # mqtt.js (MIT), qrcode-generator (MIT), jsQR (Apache-2.0)
└── tests/fila.test.js
```
