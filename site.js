const menu = document.getElementById('menu');
const nav = document.getElementById('nav');
menu.addEventListener('click', () => {
  const opened = nav.classList.toggle('open');
  menu.setAttribute('aria-expanded', String(opened));
});
nav.querySelectorAll('a').forEach(link => link.addEventListener('click', () => {
  nav.classList.remove('open');
  menu.setAttribute('aria-expanded', 'false');
}));
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && nav.classList.contains('open')) {
    nav.classList.remove('open'); menu.setAttribute('aria-expanded', 'false'); menu.focus();
  }
});
document.getElementById('year').textContent = new Date().getFullYear();
const form = document.getElementById('contactForm');
const started = document.getElementById('formStarted');
const status = document.getElementById('formStatus');
const button = form.querySelector('button[type="submit"]');
started.value = String(Date.now());
let sending = false;
form.addEventListener('submit', async event => {
  event.preventDefault();
  if (sending || !form.reportValidity()) return;
  if (location.protocol === 'file:') {
    status.textContent = 'This preview cannot receive inquiries. Please email tom@categorii.com.';
    status.focus(); return;
  }
  sending = true; button.disabled = true; status.textContent = 'Sending your inquiry…';
  try {
    const response = await fetch('/api/contact', {
      method: 'POST', headers: { 'Accept': 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(new FormData(form)), signal: AbortSignal.timeout(20000)
    });
    let result;
    try { result = await response.json(); } catch { throw new Error('The contact form is temporarily unavailable. Please email tom@categorii.com.'); }
    if (!response.ok || !result.ok || !result.id) throw new Error(result.message || 'We could not confirm receipt. Please email tom@categorii.com.');
    sessionStorage.setItem('kellsInquiryReceived', result.id);
    location.assign('/thank-you');
  } catch (error) {
    status.textContent = error.name === 'TimeoutError' ? 'Receipt could not be confirmed. Please email tom@categorii.com if you need help.' : error instanceof TypeError ? 'The connection failed. Please try again or email tom@categorii.com.' : error.message || 'We could not confirm receipt. Please email tom@categorii.com.';
    status.focus();
    sending = false; button.disabled = false;
  }
});
