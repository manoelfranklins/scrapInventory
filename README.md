# Scrap Inventory — SAP DM POD 2.0 Plugin

A POD 2.0 custom widget for SAP Digital Manufacturing that lets a shop-floor user find ERP-origin inventory stock for a material and scrap partial or full quantities, directly from the POD.

---

## What it does

- **Material filter bar** with a free-text input, a **Browse** (value-help) button, and a **Load Inventory** button.
- **Select Material dialog** (Browse): lists only materials that actually **have inventory** (ERP origin) in the current plant, with paging and instant substring search.
- **Inventory table**: Inventory ID · Quantity (with UoM) · Material / Version / Description · Storage Location · Quantity to Scrap (editable) · Scrap button.
- **Scrap action**: posts to the DM inventory scrap API with confirmation, success toast, quantity validation, and an automatic table refresh.

---

## Install / Deploy

1. Deploy `ScrapInventory_deployment.zip` via the SAP DM **Extension Center** (Plugin upload).
2. In the **POD Designer**, add the widget **Scrap Inventory** (category *Custom*) to a POD page.
3. Save and assign the POD; open it in **Run** mode.

Stable snapshots are kept alongside the active build:
- `ScrapInventory_deployment.zip` — current build.
- `ScrapInventory_deployment_v2_STABLE.zip` — frozen, verified-working snapshot.
- `ScrapInventory_deployment_v1_STABLE.zip` — earlier frozen snapshot.

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

## Build

No build step — plain AMD/UI5 JavaScript. To repackage after edits:

```bash
cd 20scrapInventory
zip -rq ScrapInventory_deployment.zip extension.json i18n widget --exclude "*.DS_Store"
# optional sanity check:
node --check widget/ScrapInventory.js
```

---

## Requirements & assumptions

- SAP Digital Manufacturing **POD 2.0** runtime.
- The POD provides a plant context (`PodContext.getPlant()`); no OperationActivity/WorkList selection is required.
- Only **ERP-origin, unrestricted** stock can be scrapped (enforced by the DM backend).

---

## Known constraints

- The inventory API has **no substring/contains search** and no "distinct materials" endpoint, so the material list is built by scanning inventory. The scan is parallelized, pre-warmed, and cached, but the very first cold load on a large plant still costs a brief one-time fetch.
- The Browse page cap bounds the scan (at most ~20k records); extremely large plants beyond the cap would not surface every material in Browse (type the material name directly and Load as a fallback).

---

## Troubleshooting

See **`!Learn 2.0/POD2_Inventory_API_Lessons_Learned.md`** for the full API-routing playbook. Quick signals:

- **403 "session expired"** on a `RestClient` call → wrong URL base (hit the POD app proxy root). Use the `ApiPaths` microservice prefix or a typed client.
- **404 `NoResourceFoundException`** → reached a Spring service but wrong sub-path.
- **404 `EntityRepresentationModel not found`** → base is a false positive (SPA 200) and/or the UoM in the scrap body is wrong/empty.
