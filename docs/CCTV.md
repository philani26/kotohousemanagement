# CCTV

The Kota House app **does not record or stream video**. Continuous video doesn't belong in Firestore: it's expensive, slow and not built for it. Recording and remote viewing are handled by the camera system. The app's **CCTV** page simply opens that system's own secure viewer.

## Recommended setup

| Item | Recommendation |
|---|---|
| Cameras | 2 to 4 IP cameras (2 MP+, night vision): **till & counter** (sees hands, cash drawer and card machine), **kitchen/prep**, **stock & fridge**, **door** |
| Recorder | 4-channel NVR with a 1 TB+ surveillance HDD (about 2 to 4 weeks of continuous recording), *or* cloud cameras with an SD card plus a cloud plan |
| Power | Put the NVR and router on a small UPS. Load-shedding gaps are exactly when losses happen. |
| Network | Wired PoE for cameras where possible. The NVR is cabled to the router. 2 to 4 Mbps upload for one remote sub-stream (LTE routers work). |
| Brands | Hikvision (Hik-Connect), Dahua (DMSS), Ezviz, TP-Link Tapo, Reolink. All have official Android and iOS viewer apps. |

## Secure remote viewing

1. Use the brand's **official app and cloud/P2P service** (Hik-Connect, DMSS, Ezviz…). It avoids opening ports on your router.
2. **Don't** port-forward the NVR to the internet. If you need direct access, use a VPN (WireGuard or Tailscale) on the router.
3. Change the default admin password on the NVR and the cameras. Turn on two-step login in the camera app.
4. Give staff **no** remote access. Share the owner's camera account only with people you trust, using the app's sharing feature with view-only rights.
5. Update the NVR firmware twice a year.

## Link it to the app

**Settings → CCTV**:
- *System / brand*, e.g. `Hik-Connect`
- *Secure web viewer link* (https), if your brand has one
- *Android* / *iPhone app* links (Play Store / App Store pages, or the app's deep link)
- *Notes*: camera names, which channel shows the till. **Never store passwords here.**

The **CCTV** page then shows *Open live view* and the app buttons.

## Using footage with the app

When **Cash-ups** shows a shortage, note the shift and close time, then review the till camera at that time and during large cash sales or payouts (times are in **Sales** and the **Activity log**).

## Privacy (POPIA)

- Put up clear signs: *“CCTV in operation”*.
- Tell employees in writing which areas are recorded and why (security and loss prevention). Don't record toilets or changing areas.
- Keep footage only as long as needed (for example 30 days), and restrict who can view or export it.

## Deeper integration (optional)

Some systems offer ISAPI/ONVIF or vendor cloud APIs (for example event or snapshot webhooks). These differ by vendor and often need a developer account. An integration would be a Cloud Function that receives events, without storing video, plus a link back to the vendor app. Check that your exact model supports it before building anything.
