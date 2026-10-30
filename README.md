# Scrap Components, Floor Stock, Inventory, directly from POD 2.0

A custom SAP Digital Manufacturing **POD 2.0** widget that empowers shop-floor operators to scrap component materials, floor stock, and inventory IDs **without ever leaving the POD**. Operators search a material, browse its ERP-origin stock across the plant, and post a partial or full scrap for a specific Inventory ID in seconds — a capability SAP Digital Manufacturing does not provide out of the box. By embedding the scrap action directly into the execution screen, it removes the context-switch to the Manage Floor Stocks app, cuts a multi-step maintenance flow down to a single entry, and keeps on-hand inventory accurate through the standard DM inventory API.

<img width="1430" height="352" alt="image" src="https://github.com/user-attachments/assets/58f7425e-6863-4cd0-9e15-59dc06a68df7" />


---

## Why we built this

Out of the box, SAP Digital Manufacturing does **not** allow scrapping a **component material / floor stock / inventory ID directly from a POD**. Yet this is a very common shop-floor requirement: an operator who finds damaged, expired, or otherwise unusable stock while executing an order has no standard way to scrap it from the POD they are already working in.

The **only** standard path for this kind of scrap posting is the separate **Manage Floor Stocks** app, where the manual procedure is:

1. Open the **Manage Floor Stocks** app.
2. Find the relevant **Inventory ID**.
3. **Edit** that stock record.
4. **Decrease the Quantity on Hand** by entering the **Quantity to Adjust**.
5. Select the reason code **`SCR-SCRAP`** and save.

<img width="1901" height="678" alt="image" src="https://github.com/user-attachments/assets/d4019731-135a-4f44-a3c6-779cbad81561" />

Reference — SAP Help: [Floor Stock Return and Scrap](https://help.sap.com/docs/sap-digital-manufacturing/execution/floor-stock-return-scrap).

This means the operator must **leave the POD**, switch to a general inventory-maintenance app, locate the stock, and perform a multi-step adjustment — friction that is impractical during live execution. **That is exactly the gap this custom POD 2.0 plugin closes**: it brings component / floor-stock / inventory-ID scrap *into* the POD itself.

### Benefits & value added

- **Scrap without leaving the POD** — operators stay in the execution context they are already working in; no app-switching to Manage Floor Stocks.
- **Faster, fewer clicks** — search a material, see its stock, type a quantity, scrap. This replaces the standard *open app → find → Edit → adjust Quantity on Hand → pick reason code → save* flow.
- **Fewer mistakes** — the plugin shows only **ERP-origin, scrap-eligible** stock, and validates the quantity against the on-hand amount before posting.
- **Role-appropriate UX** — a focused, single-purpose scrap screen for shop-floor operators instead of exposing the full Manage Floor Stocks maintenance app (and its broader permissions).
- **Lower training effort** — a purpose-built action is far simpler to learn than a general inventory app.
- **Accurate, consistent postings** — scraps go through the standard DM inventory API, so on-hand stock and downstream postings stay correct, achieving the same business outcome as the Manage Floor Stocks `SCR-SCRAP` adjustment.

---

## What it does

- **Material filter bar** with a free-text input, a **Browse** (value-help) button, and a **Load Inventory** button.
- **Select Material dialog** (Browse): lists only materials that actually **have inventory** (ERP origin) in the current plant, with paging and instant substring search.
- **Inventory table**: Inventory ID · Quantity (with UoM) · Material / Version / Description · Storage Location · Quantity to Scrap (editable) · Scrap button.
- **Scrap action**: posts to the DM inventory scrap API with confirmation, success toast, quantity validation, and an automatic table refresh.

---

## Install / Deploy

1. Deploy `ScrapInventory_deployment.zip` via Manage PODs 2.0.
<img width="1917" height="635" alt="image" src="https://github.com/user-attachments/assets/744a04f4-eff8-4190-a696-f398cf2a87c0" />

2. Add the widget **Scrap Inventory** (category *Custom Widgets*) to a POD page.
<img width="1919" height="565" alt="image" src="https://github.com/user-attachments/assets/32b9a95e-a6c5-4127-a167-1c75ebf6d901" />

3. Save and open the POD in **Run** mode, search by Material, and scrap some Quantity for a given Inventory ID
<img width="1430" height="352" alt="image" src="https://github.com/user-attachments/assets/58f7425e-6863-4cd0-9e15-59dc06a68df7" />
<img width="1702" height="713" alt="image" src="https://github.com/user-attachments/assets/770ef39d-1d52-4d82-97b8-c0ce997dabd0" />

---

## Folder structure

```
20scrapInventory/
├── extension.json              # Widget registration (widgets[] only)
├── widget/
│   └── ScrapInventory.js        # The widget (all logic)
├── i18n/
│   ├── i18n.properties          # Base/fallback bundle
│   ├── i18n_en.properties       # English
│   └── i18n_<locale>.properties # 28 SAP DM locales
└── ScrapInventory_deployment*.zip
```

`extension.json` intentionally contains only the `widgets` and `actions` arrays — the Extension Center rejects any other top-level fields.

- **Namespace / module path**: `custom/pod2/scrapInventory/widget/ScrapInventory`
- **Type**: `custom.pod2.scrapInventory.widget.ScrapInventory`
- **i18n bundle**: `custom.pod2.scrapInventory.i18n.i18n`

---

## How it works

### Data source
All inventory reads go through the typed client **`ApiClient.inventory.getInventories({ plant, material?, materialVersion?, size, page })`**, which returns a tuple `[items, totalCount]` and resolves gateway routing + auth internally. Only **ERP-origin** stocks (`item.origin === "ERP"`) are shown — those are the scrap-eligible ones.

### Select Material (Browse)
Because the inventory API filters `material` by **exact match** and paginates inventory *records* (not distinct materials), the dialog builds the material list **client-side**:

- On widget load it **pre-warms** a cache of distinct ERP materials in the background (non-blocking, run mode only).
- The scan fetches page 0 to learn the total, then fetches the remaining pages **in parallel** (capped), de-duping by `inventoryId`, bounded by a hard page cap.
- Results are cached in `sessionStorage` per plant (15-min TTL); reopening skips the scan.
- The dialog paginates and **substring-searches client-side**, so `DRILL` matches `DRILL-TIP`.
- Clicking a row selects the material and auto-loads its inventory; typing in the field and pressing Enter / leaving the field also loads.

### Scrap
There is **no scrap method on the typed client**, so scrap uses `RestClient.post`. The internal route is **resolved at runtime** (not hard-coded): candidate bases under `ApiPaths.INVENTORY_MS_PATH` (`dme/inventory-ms`) are probed with a harmless read-only GET, and the first whose response body is **real inventory JSON** (validated — guards against SPA-shell 200s) is used. Scrap then posts to `<resolvedBase>/{inventoryId}/scrap?plant=<plant>` with:

```json
{ "quantity": { "value": <qty>,
                "unitOfMeasure": { "internalUnitOfMeasure": "<stock's real UoM>" } } }
```

The UoM is taken from the stock itself (`quantityOnHand.unitOfMeasure.internalUnitOfMeasure`), never guessed.

---

## Requirements & assumptions

- SAP Digital Manufacturing **POD 2.0** runtime.
- The POD provides a plant context (`PodContext.getPlant()`); no OperationActivity/WorkList selection is required.
- Only **ERP-origin, unrestricted** stock can be scrapped (enforced by the DM backend).

## License
This project is licensed under the MIT License - see the LICENSE file for details.

## 👨‍💻 Author
Manoel Costa http://manoelcosta.com/

Disclaimer: This is a community extension and is not officially supported by SAP. Use at your own discretion.
