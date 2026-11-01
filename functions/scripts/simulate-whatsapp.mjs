/**
 * Pretends to be a WhatsApp customer messaging the shop, against the LOCAL
 * emulators only. The shop must have WhatsApp ordering switched on with the
 * same phone number ID (Settings › WhatsApp ordering).
 *
 *   node functions/scripts/simulate-whatsapp.mjs "hi"
 *   node functions/scripts/simulate-whatsapp.mjs "2x2, 7" [phoneNumberId] [customerNumber] [customerName]
 *
 * Replies are recorded as "dry run" messages; see Settings › WhatsApp ordering.
 */
const [text = 'hi', phoneNumberId = '1000000001', from = '27820000001', name = 'Test Customer'] = process.argv.slice(2);

const res = await fetch('http://127.0.0.1:5001/demo-kotahouse/africa-south1/whatsappWebhook', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: phoneNumberId },
              contacts: [{ wa_id: from, profile: { name } }],
              messages: [{ id: `sim.${Date.now()}`, from, type: 'text', text: { body: text } }],
            },
          },
        ],
      },
    ],
  }),
});
console.log(`Sent "${text}" as ${name} (${from}) → webhook answered ${res.status}`);
console.log('See the replies under Settings › WhatsApp ordering, and new orders on Orders.');
