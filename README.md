# Scrap Inventory — SAP DM POD 2.0 Plugin

A POD 2.0 custom widget for SAP Digital Manufacturing that lets a shop-floor user find ERP-origin inventory stock for a material and scrap partial or full quantities, directly from POD 2.0.

<img width="1430" height="352" alt="image" src="https://github.com/user-attachments/assets/58f7425e-6863-4cd0-9e15-59dc06a68df7" />


---

## What it does

- **Material filter bar** with a free-text input, a **Browse** (value-help) button, and a **Load Inventory** button.
- **Select Material dialog** (Browse): lists only materials that actually **have inventory** (ERP origin) in the current plant, with paging and instant substring search.
- **Inventory table**: Inventory ID · Quantity (with UoM) · Material / Version / Description · Storage Location · Quantity to Scrap (editable) · Scrap button.
- **Scrap action**: posts to the DM inventory scrap API with confirmation, success toast, quantity validation, and an automatic table refresh.

---

## Install / Deploy

1. Deploy `ScrapInventory_deployment.zip` via Manage PODs 2.0.
2. Add the widget **Scrap Inventory** (category *Custom Widgets*) to a POD page.
3. Save and assign the POD; open it in **Run** mode.

<img width="1917" height="635" alt="image" src="https://github.com/user-attachments/assets/744a04f4-eff8-4190-a696-f398cf2a87c0" />


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
