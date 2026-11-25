const URL = 'http://localhost:5000/voice/callback';
const sessionId = 'test' + Date.now();
const phone = '+254769399819';
const mode = process.argv[2];

async function hit(label, fields) {
  const body = new URLSearchParams({ sessionId, callerNumber: phone, direction: 'Inbound', ...fields });
  const res = await fetch(URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  const text = await res.text();
  console.log('\n=== ' + label + ' ===');
  console.log(text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
}

async function main() {
  await hit('Call starts', { isActive: '1' });
  if (mode === 'buy') await hit('Press 1 to buy the first package', { isActive: '1', dtmfDigits: '1' });
  await hit('Child presses 2', { isActive: '1', dtmfDigits: '2' });
  await hit('Child presses 9 to stop', { isActive: '1', dtmfDigits: '9' });
  await hit('Call ends after 130 seconds', { isActive: '0', durationInSeconds: '130' });
}

main().catch((e) => console.log('FAILED:', e.message));