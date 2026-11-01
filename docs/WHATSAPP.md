# WhatsApp ordering

Customers order by WhatsApp. The order appears on the **Orders** queue, and the customer is messaged automatically as staff tap it along. They pay when they collect.

## How it works

```
Customer: hi
Bot:      👋 Welcome to Mzansi Kota House! Here's our menu:
          1. Basic Kota – R 30,00
          2. Russian Kota – R 45,00
          …
          To order, reply with the item number and quantity, e.g. 3x2, 6
Customer: 2x2, 7
Bot:      Here's your order:
          • 2× Russian Kota – R 90,00
          • 1× Cold drink – R 15,00
          Total: R 105,00 (pay at collection)
          Reply YES to place it, or send a new list to change it.
Customer: note: no atchar
Customer: yes
Bot:      ✅ Order #W12 received! Total R 105,00, pay when you collect.
          (Staff tap “Start preparing”)
Bot:      👨‍🍳 Your order #W12 is being prepared.
          (Staff tap “Ready”)
Bot:      ✅ Your order #W12 is ready to collect at Mzansi Kota House! Please pay R 105,00 when you collect.
```

- **Commands:** **menu**, **status** (where's my order?), **cancel**, **note: …**
- **When closed:** outside trading hours, or when no shift is open, the bot says the shop is closed and gives your hours.
- **Numbering:** WhatsApp orders are numbered **W1, W2…** so they never clash with till orders (1, 2, 3…) on the board.
- **On the queue:** the ticket shows a 💬 badge, the customer's name, the order number and the amount to pay. **Charge** loads it into the till. After payment it's marked **Paid**, and the sale goes through the normal cash-up, stock and reports.
- **Every message, in and out,** is kept in **Settings › WhatsApp ordering › Latest messages**.

## What you need from Meta (one-time, about 30 minutes)

WhatsApp only allows automated messages through Meta's **WhatsApp Business Platform (Cloud API)**.

1. **Meta Business account:** create one at https://business.facebook.com and verify your business.
2. **App:** go to https://developers.facebook.com → *My Apps → Create app → Business*, then add the **WhatsApp** product.
3. **Phone number:** *WhatsApp → API setup → Add phone number*. Use a number that is **not** already on the WhatsApp app, e.g. a new SIM for the shop. Verify it by SMS. Copy the **Phone number ID**, a long number.
4. **Permanent token:** in *Business settings → Users → System users*, create a system user. Give it the app and the WhatsApp account, then **Generate token** with `whatsapp_business_messaging` and `whatsapp_business_management` permissions.
5. **App secret:** *App settings → Basic → App secret*.
6. **Put the secrets in** `functions/.env.prod` (git-ignored; do the same in `.env.dev` for the test project):
   ```
   WHATSAPP_TOKEN=EAAG...            # the permanent token
   WHATSAPP_APP_SECRET=abc123...     # the app secret
   WHATSAPP_VERIFY_TOKEN=make-up-a-long-random-string
   ```
   Then deploy: `firebase deploy --only functions --project prod`.
7. **Webhook:** *WhatsApp → Configuration → Webhook → Edit*
   - Callback URL: `https://africa-south1-kotahouse-prod.cloudfunctions.net/whatsappWebhook`
   - Verify token: the same `WHATSAPP_VERIFY_TOKEN`
   - Then subscribe to **messages**.
8. **In the app:** *Settings › WhatsApp ordering*. Enter the number customers message and the **Phone number ID**, tick **Take orders on WhatsApp**, and click **Save**.

Send "hi" from your own phone to test it.

## Costs and rules

- **Customer-started conversations are free** under Meta's current pricing. Replies within 24 hours of the customer's last message, which covers every message this bot sends, are free-form "service" messages. Check Meta's current pricing for South Africa.
- **No marketing messages:** this feature only answers customers and updates them on their own order.
- **Payments are not taken on WhatsApp.** Customers pay at collection, so card data never goes near WhatsApp.

## Safety

- **Signatures:** every webhook call is checked against Meta's signature (`WHATSAPP_APP_SECRET`). Calls without a valid signature are refused in production.
- **Duplicates:** each WhatsApp message is processed once, even if Meta delivers it twice.
- **Access:** the token and app secret live only in the Cloud Functions configuration, never in the app or in git.
- **Abuse limits:** the bot never takes more than 20 items or 10 of one item in an order. A customer who orders and never collects simply leaves an unpaid ticket. Collected-but-unpaid orders are impossible, because **Charge** is how the ticket gets paid.

## Trying it without Meta (dry run)

Without `WHATSAPP_TOKEN` the bot works the same, but replies are only recorded (marked *not sent – dry run*) instead of being sent. To simulate a customer on your PC:

```bash
node functions/scripts/simulate-whatsapp.mjs "hi"
node functions/scripts/simulate-whatsapp.mjs "2x2, 7"
node functions/scripts/simulate-whatsapp.mjs "yes"
```

Watch the order appear on **Orders**, and the bot's replies under **Settings › WhatsApp ordering**.
