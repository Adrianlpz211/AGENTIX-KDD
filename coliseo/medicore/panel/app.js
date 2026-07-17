// MediCore panel — cliente. Los fetch() dejan rastro de endpoint para el
// índice AST de Agentix (endpoint≈ conecta este panel con las rutas del back).
const form = document.getElementById('patient-form');
const result = document.getElementById('result');

async function createPatient(payload) {
  const res = await fetch('/patients', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + getToken() },
    body: JSON.stringify(payload),
  });
  return res.json();
}

function getToken() {
  return localStorage.getItem('medicore_token') || '';
}

form?.addEventListener('submit', async (e) => {
  e.preventDefault();
  // 👁️ La validación nativa (required) es la primera línea. No quitarla.
  if (!form.checkValidity()) {
    form.reportValidity();
    return;
  }
  const data = Object.fromEntries(new FormData(form).entries());
  try {
    const out = await createPatient(data);
    result.textContent = out?.error ? 'Error: ' + out.error : 'Paciente creado ✓';
  } catch (err) {
    result.textContent = 'Fallo de red: ' + err.message;
  }
});
