/* scanner.js — lê QR code pela câmera (BarcodeDetector nativo ou jsQR). */

let jsQRCarregando = null;
function carregarJsQR() {
    if (window.jsQR) return Promise.resolve();
    jsQRCarregando = jsQRCarregando || new Promise((ok, erro) => {
        const s = document.createElement('script');
        s.src = new URL('../vendor/jsQR.js', import.meta.url).href;
        s.onload = ok; s.onerror = () => erro(new Error('Não foi possível carregar o leitor de QR.'));
        document.head.appendChild(s);
    });
    return jsQRCarregando;
}

/**
 * Abre a câmera dentro de `container` e chama aoLer(texto) quando achar um QR.
 * Retorna uma função para parar.
 */
export async function escanear(container, aoLer) {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Este navegador não permite usar a câmera aqui. Use o app da câmera do celular.');
    container.innerHTML = '<div class="scanner"><video playsinline muted></video><div class="mira" aria-hidden="true"></div></div>';
    const video = container.querySelector('video');
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    video.srcObject = stream;
    await video.play();

    let detector = null;
    if ('BarcodeDetector' in window) {
        try { detector = new window.BarcodeDetector({ formats: ['qr_code'] }); } catch (e) { detector = null; }
    }
    if (!detector) await carregarJsQR();
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    let ativo = true;
    const parar = () => { ativo = false; stream.getTracks().forEach((t) => t.stop()); };
    async function quadro() {
        if (!ativo) return;
        try {
            if (video.readyState >= 2) {
                let texto = null;
                if (detector) {
                    const r = await detector.detect(video);
                    texto = r[0]?.rawValue || null;
                } else {
                    const w = video.videoWidth, h = video.videoHeight;
                    const escala = Math.min(1, 640 / Math.max(w, h));
                    canvas.width = Math.round(w * escala); canvas.height = Math.round(h * escala);
                    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
                    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
                    texto = window.jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' })?.data || null;
                }
                if (texto) { parar(); aoLer(texto); return; }
            }
        } catch (e) { /* tenta de novo no próximo quadro */ }
        setTimeout(quadro, 200);
    }
    quadro();
    return parar;
}
