# Notifications

All alerts are stored in `businesses/{b}/notifications` and shown in the app (bell icon, Alerts page, critical alerts on the dashboard). Each one has a severity of *info*, *warning* or *critical*.

| Alert | Raised by | Default threshold (Settings) |
|---|---|---|
| Cash short or over | `closeShift` | more than R20 difference |
| Card machine differs from recorded card sales | `closeShift` | any difference |
| Stock count variance | `closeShift` | more than R50 at cost |
| Shift closed summary | `closeShift` | always (info) |
| Low stock | `recordSale` when an item crosses its reorder level | per ingredient |
| Refund requested | `requestRefund` | critical above R100 |
| Large discount | `recordSale` | from 10% |
| Offline sale total changed (price changed before it synced) | `recordSale` | any difference |
| Excessive wastage | `recordStockMovement` | more than R50 in a day (once per day) |
| Expense to approve | `submitExpense` | always |
| Stock paid from till / cash paid out | `recordPurchase` / `recordPayout` | always (info) |
| Closing report missing | `monitorActivity` every 15 min | 60 min after closing time |
| No sales | `monitorActivity` | 120 min during trading hours |
| Shop not opened | `monitorActivity` | 1 h after opening on trading days |

Scheduled alerts use deterministic ids, so each is raised only once.

## Email

1. Install the **Trigger Email from Firestore** extension (`firebase ext:install firebase/firestore-send-email`). Set the collection to `mail` and give it SMTP details (e.g. Gmail app password, SendGrid, Mailgun).
2. In **Settings → Notifications**, tick *Also email warning & critical alerts* and enter the address(es).

`notify()` in `functions/src/common.ts` writes a `mail` document for each warning or critical alert.

## WhatsApp

WhatsApp messages need the **WhatsApp Business Platform (Cloud API)**: a Meta Business account, a verified business phone number and approved message templates, either directly or through a provider (Twilio, 360dialog, Clickatell…). There are per-conversation charges.

It's intentionally **not implemented** until a provider has been chosen and approved. To add it:
1. Store the provider token in Secret Manager: `firebase functions:secrets:set WHATSAPP_TOKEN`.
2. Add a Firestore trigger on `businesses/{b}/notifications/{id}` that, when `settings.notifications.whatsapp` is on and the severity is warning or critical, sends an approved template to `whatsappTo`.
3. Never put the token in the Angular app.
