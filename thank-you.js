const received = sessionStorage.getItem('kellsInquiryReceived') || new URLSearchParams(location.search).get('received') === '1';
if (received) {
  document.getElementById('confirmationTitle').textContent = 'Thanks for reaching out.';
  document.getElementById('confirmationText').textContent = 'Your inquiry has been received. Tom will review the context before responding.';
  sessionStorage.removeItem('kellsInquiryReceived');
  // Tell the Meta Pixel an inquiry was sent: the event only, never what was written.
  if (typeof window.fbq === 'function') window.fbq('track', 'Lead');
  if (location.search) history.replaceState(null, '', location.pathname);
}
