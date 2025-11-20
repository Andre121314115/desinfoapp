// frontend/js/config.js
// Selecciona automáticamente la URL del backend según el entorno.
(function () {
  const isLocal =
    location.hostname === 'localhost' ||
    location.hostname === '127.0.0.1';

  // En local usa tu API local, en producción usa tu Web Service de Render:
  window.API_BASE = isLocal
    ? 'http://localhost:3000'                   // desarrollo local
    : 'https://desinfoapp-8olm.onrender.com';   // backend en Render

  // (opcional) para depurar:
  console.log('[config] API_BASE =', window.API_BASE);
})();
