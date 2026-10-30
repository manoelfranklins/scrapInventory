sap.ui.define([
    "sap/dm/dme/pod2/widget/Widget",
    "sap/dm/dme/pod2/context/PodContext",
    "sap/dm/dme/pod2/model/I18nResourceModel",
    "sap/dm/dme/pod2/Logger",
    "sap/dm/dme/pod2/context/MessageHistory",
    "sap/dm/dme/pod2/api/ApiClient",
    "sap/dm/dme/pod2/api/RestClient",
    "sap/dm/dme/pod2/api/ApiPaths",
    "sap/ui/model/json/JSONModel",
    "sap/m/VBox",
    "sap/m/HBox",
    "sap/m/Input",
    "sap/m/Button",
    "sap/m/ButtonType",
    "sap/m/Table",
    "sap/m/Column",
    "sap/m/ColumnListItem",
    "sap/m/Text",
    "sap/m/Label",
    "sap/m/Dialog",
    "sap/m/List",
    "sap/m/StandardListItem",
    "sap/m/ListType",
    "sap/m/SearchField",
    "sap/m/MessageBox"
], (
    Widget,
    PodContext,
    I18nResourceModel,
    Logger,
    MessageHistory,
    ApiClient,
    RestClient,
    ApiPaths,
    JSONModel,
    VBox,
    HBox,
    Input,
    Button,
    ButtonType,
    Table,
    Column,
    ColumnListItem,
    Text,
    Label,
    Dialog,
    List,
    StandardListItem,
    ListType,
    SearchField,
    MessageBox
) => {
    "use strict";

    class ScrapInventory extends Widget {

        static #oI18nModel = new I18nResourceModel({
            bundleName: "custom.pod2.scrapInventory.i18n.i18n"
        });

        static #BROWSE_PAGE_SIZE = 50;

        static getI18nModel() { return ScrapInventory.#oI18nModel; }
        static getDisplayName() { return "Scrap Inventory"; }
        static getIcon() { return "sap-icon://sys-cancel"; }
        static getCategory() { return "Custom"; }

        #oLog = Logger.getLogger("custom.pod2.scrapInventory.widget.ScrapInventory");
        #oMaterialInput = null;
        #oTable = null;
        #oBrowseDialog = null;
        #oBrowseList = null;
        #oBrowseModel = new JSONModel({ materials: [] });
        #aAllMaterials = [];       // cached distinct ERP materials (fetched once per session)
        #pMaterialsPromise = null;  // in-flight material load shared by pre-warm and Browse
        #oBrowseSearchField = null;
        #iBrowsePage = 0;
        #iBrowseTotalPages = 1;
        #sBrowseFilter = "";
        #oBrowsePageText = null;
        #oBrowsePrevBtn = null;
        #oBrowseNextBtn = null;
        #sMaterial = null;
        #sVersion = null;
        #sInventoryBase = null;   // resolved RestClient base for the inventory microservice (cached)

        // ─── Lifecycle ──────────────────────────────────────────────────────────

        async onInit() {
            await super.onInit();
            // Pre-warm the material cache in the background (non-blocking, bounded, parallel) so the
            // Select Material dialog is ready — ideally instant — by the time the user opens it.
            if (PodContext.isRunMode && PodContext.isRunMode()) {
                this._prewarmMaterials();
            }
        }

        _createView() {
            const oConfig = this.getConfig();
            if (!oConfig || !oConfig.id) {
                return new VBox({ items: [new Text({ text: "Configuration error" })] });
            }

            const oMaterialLabel = new Label({ text: this.getI18nText("filter.material.label") });
            oMaterialLabel.addStyleClass("sapUiSmallMarginEnd");

            this.#oMaterialInput = new Input({
                placeholder: this.getI18nText("filter.material.placeholder"),
                width: "280px",
                // change fires on both Enter and focus-loss → auto Load Inventory.
                // Manual typing clears any prior browse selection so the typed value wins.
                change: () => {
                    this.#sMaterial = null;
                    this.#sVersion = null;
                    this._triggerLoad();
                }
            });
            this.#oMaterialInput.addStyleClass("sapUiSmallMarginEnd");

            const oBrowseBtn = new Button({
                icon: "sap-icon://value-help",
                tooltip: this.getI18nText("button.browse"),
                press: () => this._onBrowsePress()
            });
            oBrowseBtn.addStyleClass("sapUiSmallMarginEnd");

            const oLoadBtn = new Button({
                text: this.getI18nText("button.load"),
                icon: "sap-icon://refresh",
                type: ButtonType.Emphasized,
                press: () => this._triggerLoad()
            });

            const oFilterBar = new HBox({
                alignItems: "Center",
                items: [oMaterialLabel, this.#oMaterialInput, oBrowseBtn, oLoadBtn]
            });
            oFilterBar.addStyleClass("sapUiSmallMarginBottom");

            this.#oTable = new Table({
                noDataText: this.getI18nText("table.noData"),
                columns: [
                    new Column({ header: new Label({ text: this.getI18nText("column.inventoryId") }),    width: "15%" }),
                    new Column({ header: new Label({ text: this.getI18nText("column.quantity") }),        width: "12%" }),
                    new Column({ header: new Label({ text: this.getI18nText("column.material") }),        width: "28%" }),
                    new Column({ header: new Label({ text: this.getI18nText("column.storageLocation") }), width: "15%" }),
                    new Column({ header: new Label({ text: this.getI18nText("column.quantityToScrap") }), width: "15%" }),
                    new Column({ header: new Label({ text: this.getI18nText("column.action") }),           width: "10%" })
                ]
            });

            return new VBox(oConfig.id, { items: [oFilterBar, this.#oTable] });
        }

        onExit() {
            if (this.#oBrowseDialog) {
                this.#oBrowseDialog.destroy();
                this.#oBrowseDialog = null;
            }
            this.#oMaterialInput = null;
            this.#oTable = null;
            this.#oBrowseList = null;
            this.#oBrowseModel = null;
            super.onExit();
        }

        // ─── Material Browse ─────────────────────────────────────────────────

        _onBrowsePress() {
            this.#iBrowsePage = 0;
            this.#sBrowseFilter = "";
            this._openBrowseDialog();
            if (this.#oBrowseSearchField) this.#oBrowseSearchField.setValue("");
            this._ensureMaterialsLoaded();
        }

        // Fetch all ERP materials ONCE (cached), then paginate/search entirely client-side so
        // pages contain distinct materials (not inventory records) and substring search works.
        async _ensureMaterialsLoaded() {
            if (this.#aAllMaterials.length > 0) {
                this._renderBrowsePage();
                return;
            }
            // Session cache: reopening skips the scan entirely.
            const aCached = this._readMaterialsCache();
            if (aCached) {
                this.#aAllMaterials = aCached;
                this._renderBrowsePage();
                return;
            }

            if (this.#oBrowseList) this.#oBrowseList.setBusy(true);
            try {
                await this._loadMaterialsShared(true);   // progressive render while loading
            } catch (oErr) {
                this.#oLog.error("Failed to load materials", oErr);
                MessageBox.error(this.getI18nText("message.loadMaterialsError") + ":\n" + oErr.message);
            } finally {
                if (this.#oBrowseList) this.#oBrowseList.setBusy(false);
            }
            this._renderBrowsePage();
        }

        // Background, non-blocking cache build at widget load (parallel + bounded). Ignores errors.
        _prewarmMaterials() {
            if (this.#aAllMaterials.length > 0) return;
            const aCached = this._readMaterialsCache();
            if (aCached) {
                this.#aAllMaterials = aCached;
                return;
            }
            this._loadMaterialsShared(false)
                .catch(oErr => this.#oLog.warn("Material pre-warm failed (will load on Browse)", oErr));
        }

        // Single shared loader: pre-warm and Browse reuse the same in-flight promise, so the plant
        // inventory is scanned at most once. bProgressive renders each batch as it arrives.
        _loadMaterialsShared(bProgressive) {
            if (this.#pMaterialsPromise) return this.#pMaterialsPromise;

            const sPlant = PodContext.getPlant();
            let bFirstBatch = true;
            const fnProgress = bProgressive
                ? (aSoFar) => {
                    this.#aAllMaterials = this._materialsFromInventory(aSoFar);
                    this._renderBrowsePage();
                    if (bFirstBatch && this.#oBrowseList) {
                        this.#oBrowseList.setBusy(false);   // list usable while rest loads
                        bFirstBatch = false;
                    }
                }
                : undefined;

            this.#pMaterialsPromise = this._getAllInventories({ plant: sPlant }, fnProgress)
                .then(aItems => {
                    this.#aAllMaterials = this._materialsFromInventory(aItems);
                    this._writeMaterialsCache(this.#aAllMaterials);
                    return this.#aAllMaterials;
                })
                .finally(() => { this.#pMaterialsPromise = null; });

            return this.#pMaterialsPromise;
        }

        // Dedup inventory records → sorted distinct ERP materials.
        _materialsFromInventory(aItems) {
            const oSeen = new Map();
            (aItems || []).filter(item => item.origin === "ERP").forEach(item => {
                const sKey = item.materialVersion
                    ? `${item.material}::${item.materialVersion}`
                    : item.material;
                if (item.material && !oSeen.has(sKey)) {
                    oSeen.set(sKey, {
                        material:        item.material,
                        materialVersion: item.materialVersion || "",
                        description:     item.description || "",
                        displayTitle:    item.materialVersion
                            ? `${item.material} / ${item.materialVersion}`
                            : (item.material || "")
                    });
                }
            });
            return [...oSeen.values()].sort((a, b) => a.displayTitle.localeCompare(b.displayTitle));
        }

        _materialsCacheKey() {
            return "scrapInventory.materials." + (PodContext.getPlant() || "");
        }

        _readMaterialsCache() {
            try {
                const sRaw = window.sessionStorage.getItem(this._materialsCacheKey());
                if (!sRaw) return null;
                const oEntry = JSON.parse(sRaw);
                if (!oEntry || !Array.isArray(oEntry.materials) || typeof oEntry.ts !== "number") return null;
                if (Date.now() - oEntry.ts > 15 * 60 * 1000) return null;   // 15-min TTL
                return oEntry.materials;
            } catch (oErr) {
                return null;
            }
        }

        _writeMaterialsCache(aMaterials) {
            try {
                window.sessionStorage.setItem(
                    this._materialsCacheKey(),
                    JSON.stringify({ ts: Date.now(), materials: aMaterials })
                );
            } catch (oErr) {
                this.#oLog.debug("Could not cache materials in sessionStorage", oErr);
            }
        }

        // Case-insensitive substring match across material, version and description.
        _getFilteredMaterials() {
            const sTerm = this.#sBrowseFilter.toLowerCase();
            if (!sTerm) return this.#aAllMaterials;
            return this.#aAllMaterials.filter(m =>
                (m.material        || "").toLowerCase().includes(sTerm) ||
                (m.materialVersion || "").toLowerCase().includes(sTerm) ||
                (m.description     || "").toLowerCase().includes(sTerm));
        }

        _renderBrowsePage() {
            const aFiltered = this._getFilteredMaterials();
            const iSize = ScrapInventory.#BROWSE_PAGE_SIZE;
            this.#iBrowseTotalPages = Math.max(1, Math.ceil(aFiltered.length / iSize));
            if (this.#iBrowsePage >= this.#iBrowseTotalPages) this.#iBrowsePage = this.#iBrowseTotalPages - 1;
            if (this.#iBrowsePage < 0) this.#iBrowsePage = 0;

            const iStart = this.#iBrowsePage * iSize;
            this.#oBrowseModel.setProperty("/materials", aFiltered.slice(iStart, iStart + iSize));
            this._updateBrowsePager();
        }

        _updateBrowsePager() {
            if (this.#oBrowsePageText) {
                this.#oBrowsePageText.setText(`${this.#iBrowsePage + 1} / ${this.#iBrowseTotalPages}`);
            }
            if (this.#oBrowsePrevBtn) this.#oBrowsePrevBtn.setEnabled(this.#iBrowsePage > 0);
            if (this.#oBrowseNextBtn) this.#oBrowseNextBtn.setEnabled(this.#iBrowsePage + 1 < this.#iBrowseTotalPages);
        }

        // Collects inventory records across pages. Fetches page 0 to learn the total, then fetches
        // the remaining pages in PARALLEL (capped) instead of sequentially — the big speed win.
        // Optional fnProgress(aSoFar) is called after page 0 and after each parallel batch so the
        // caller can render progressively. Bounded by a hard page cap; de-dupes by inventoryId.
        async _getAllInventories(oBaseRequest, fnProgress) {
            const iSize       = 500;
            const iMaxPage    = 40;   // hard cap: at most 20000 records scanned
            const iConcurrency = 8;
            const aAll        = [];
            const oSeenIds    = new Set();

            const addItems = (aItems) => {
                (aItems || []).forEach(oItem => {
                    const sId = oItem.inventoryId || JSON.stringify(oItem);
                    if (!oSeenIds.has(sId)) {
                        oSeenIds.add(sId);
                        aAll.push(oItem);
                    }
                });
            };

            // Page 0 — also tells us the total record count.
            const [aFirst, iCount] = await ApiClient.inventory.getInventories(
                Object.assign({}, oBaseRequest, { size: iSize, page: 0 })
            );
            addItems(aFirst);
            if (fnProgress) fnProgress(aAll);
            if (!Array.isArray(aFirst) || aFirst.length === 0) return aAll;

            const iTotal      = (typeof iCount === "number") ? iCount : aFirst.length;
            const iTotalPages = Math.min(iMaxPage, Math.max(1, Math.ceil(iTotal / iSize)));

            // Remaining pages, fetched concurrently in batches.
            const aPages = [];
            for (let p = 1; p < iTotalPages; p++) aPages.push(p);

            for (let i = 0; i < aPages.length; i += iConcurrency) {
                const aBatch = aPages.slice(i, i + iConcurrency);
                const aResults = await Promise.all(aBatch.map(iPageNo =>
                    ApiClient.inventory.getInventories(
                        Object.assign({}, oBaseRequest, { size: iSize, page: iPageNo })
                    ).then(aTuple => Array.isArray(aTuple) ? aTuple[0] : []).catch(() => [])
                ));
                aResults.forEach(addItems);
                if (fnProgress) fnProgress(aAll);
            }
            return aAll;
        }

        _openBrowseDialog() {
            if (!this.#oBrowseDialog) {
                this.#oBrowseSearchField = new SearchField({
                    width: "100%",
                    placeholder: this.getI18nText("dialog.material.search"),
                    // Client-side substring search over the cached material list (instant, no API cost)
                    liveChange: (oEvent) => this._onBrowseSearch(oEvent.getParameter("newValue") || ""),
                    search: (oEvent) => this._onBrowseSearch(oEvent.getParameter("query") || "")
                });
                this.#oBrowseSearchField.addStyleClass("sapUiSmallMarginBottom");

                this.#oBrowseList = new List({
                    mode: "SingleSelectMaster",
                    noDataText: this.getI18nText("dialog.material.noData"),
                    growing: false,
                    // Click a row → select immediately, no Select button needed
                    itemPress: (oEvent) => this._applyBrowseSelection(oEvent.getParameter("listItem"))
                });
                this.#oBrowseList.setModel(this.#oBrowseModel);
                this.#oBrowseList.bindItems({
                    path: "/materials",
                    template: new StandardListItem({
                        title: "{displayTitle}",
                        description: "{description}",
                        type: ListType.Active
                    })
                });

                this.#oBrowsePrevBtn = new Button({
                    icon: "sap-icon://navigation-left-arrow",
                    tooltip: this.getI18nText("button.previous"),
                    enabled: false,
                    press: () => this._onBrowsePrevPage()
                });
                this.#oBrowseNextBtn = new Button({
                    icon: "sap-icon://navigation-right-arrow",
                    tooltip: this.getI18nText("button.next"),
                    enabled: false,
                    press: () => this._onBrowseNextPage()
                });
                this.#oBrowsePageText = new Text({ text: "1 / 1" });
                this.#oBrowsePageText.addStyleClass("sapUiSmallMarginBegin sapUiSmallMarginEnd");

                const oPager = new HBox({
                    alignItems: "Center",
                    justifyContent: "Center",
                    items: [this.#oBrowsePrevBtn, this.#oBrowsePageText, this.#oBrowseNextBtn]
                });
                oPager.addStyleClass("sapUiSmallMarginTop");

                this.#oBrowseDialog = new Dialog({
                    title: this.getI18nText("dialog.material.title"),
                    contentWidth: "500px",
                    contentHeight: "480px",
                    content: [
                        new VBox({ items: [this.#oBrowseSearchField, this.#oBrowseList, oPager] })
                    ],
                    endButton: new Button({
                        text: this.getI18nText("button.cancel"),
                        press: () => this.#oBrowseDialog.close()
                    }),
                    afterClose: () => {
                        if (this.#oBrowseList) {
                            this.#oBrowseList.removeSelections(true);
                        }
                    }
                });
            }

            this.#oBrowseDialog.open();
        }

        _onBrowseSearch(sQuery) {
            this.#sBrowseFilter = (sQuery || "").trim();
            this.#iBrowsePage = 0;
            this._renderBrowsePage();
        }

        _onBrowsePrevPage() {
            if (this.#iBrowsePage > 0) {
                this.#iBrowsePage--;
                this._renderBrowsePage();
            }
        }

        _onBrowseNextPage() {
            if (this.#iBrowsePage + 1 < this.#iBrowseTotalPages) {
                this.#iBrowsePage++;
                this._renderBrowsePage();
            }
        }

        _onBrowseSelect() {
            this._applyBrowseSelection(this.#oBrowseList.getSelectedItem());
        }

        _applyBrowseSelection(oItem) {
            if (!oItem) {
                MessageBox.error(this.getI18nText("message.noMaterialSelected"));
                return;
            }
            const oMat = oItem.getBindingContext().getObject();
            this.#sMaterial = oMat.material;
            this.#sVersion  = oMat.materialVersion || "";
            this.#oMaterialInput.setValue(oMat.displayTitle);
            this.#oBrowseDialog.close();
            // Selecting a material auto-loads its inventory
            this._triggerLoad();
        }

        // ─── Inventory Load ──────────────────────────────────────────────────

        _triggerLoad() {
            try {
                const sMaterialRaw = this.#sMaterial
                    || (this.#oMaterialInput && this.#oMaterialInput.getValue().trim().split(" / ")[0].trim())
                    || "";

                if (!sMaterialRaw) {
                    MessageBox.error(this.getI18nText("message.noMaterial"));
                    return;
                }

                if (this.#oTable) this.#oTable.setBusy(true);
                this._fetchInventory(sMaterialRaw, this.#sVersion || "")
                    .then(aItems => {
                        if (this.#oTable) this.#oTable.setBusy(false);
                        this._populateTable(aItems);
                    })
                    .catch(oErr => {
                        if (this.#oTable) {
                            this.#oTable.setBusy(false);
                            this.#oTable.removeAllItems();  // don't leave stale rows after a failed load
                        }
                        this.#oLog.error("Failed to load inventory", oErr);
                        MessageBox.error(this.getI18nText("message.loadError") + ":\n" + oErr.message);
                    });
            } catch (oErr) {
                if (this.#oTable) this.#oTable.setBusy(false);
                this.#oLog.error("_triggerLoad error", oErr);
                MessageBox.error("Load error: " + (oErr.message || String(oErr)));
            }
        }

        async _fetchInventory(sMaterial, sVersion) {
            const sPlant   = PodContext.getPlant();
            const oRequest = { plant: sPlant, material: sMaterial };
            if (sVersion) oRequest.materialVersion = sVersion;

            const aItems = await this._getAllInventories(oRequest);
            return aItems.filter(item => item.origin === "ERP");
        }

        _populateTable(aItems) {
            this.#oTable.removeAllItems();
            aItems.forEach(oItem => {
                const oQtyInput = new Input({ type: "Number", placeholder: "0", width: "110px" });
                const oScrapBtn = new Button({
                    text: this.getI18nText("button.scrap"),
                    type: ButtonType.Reject,
                    press: () => this._onScrapPress(oItem, oQtyInput)
                });
                const sMaterialCell = [oItem.material, oItem.materialVersion, oItem.description].filter(Boolean).join(" / ");
                const fQty = oItem.quantityOnHand?.value ?? 0;
                const sUOM = oItem.quantityOnHand?.unitOfMeasure?.internalUnitOfMeasure || "";
                const sQtyCell = sUOM ? `${fQty} ${sUOM}` : String(fQty);

                this.#oTable.addItem(new ColumnListItem({
                    cells: [
                        new Text({ text: String(oItem.inventoryId || "") }),
                        new Text({ text: sQtyCell }),
                        new Text({ text: sMaterialCell }),
                        new Text({ text: String(oItem.storageLocation || "") }),
                        oQtyInput,
                        oScrapBtn
                    ]
                }));
            });
        }

        // ─── Scrap Action ────────────────────────────────────────────────────

        _onScrapPress(oItem, oQtyInput) {
            const sQty = oQtyInput.getValue().trim();
            if (!sQty) {
                MessageBox.error(this.getI18nText("message.noQuantity"));
                return;
            }
            const fQty = parseFloat(sQty);
            if (isNaN(fQty) || fQty <= 0) {
                MessageBox.error(this.getI18nText("message.invalidQuantity"));
                return;
            }
            const fAvail = parseFloat(oItem.quantityOnHand?.value) || 0;
            if (fQty > fAvail) {
                MessageBox.error(this.getI18nText("message.quantityExceedsAvailable"));
                return;
            }

            MessageBox.confirm(
                this.getI18nText("message.confirmScrap", [fQty, oItem.inventoryId]),
                {
                    actions: [MessageBox.Action.OK, MessageBox.Action.CANCEL],
                    onClose: (sAction) => {
                        if (sAction === MessageBox.Action.OK) {
                            this._executeScrap(oItem, fQty).catch(oErr => {
                                this.#oLog.error("Scrap failed", oErr);
                                const sDetail = oErr && (oErr.responseText || oErr.message) || String(oErr);
                                MessageBox.error(this.getI18nText("message.scrapError") + ":\n" + sDetail);
                            });
                        }
                    }
                }
            );
        }

        // Resolves the inventory microservice REST base that RestClient must use for writes.
        // Probe candidates with a harmless GET and keep the first that returns REAL inventory JSON
        // (a `content` array or a stock array) — NOT a 200 SPA-shell false positive. The scrap
        // endpoint lives at that same base + "/{id}/scrap" (same OpenAPI root as GET /inventories).
        async _resolveInventoryBase() {
            if (this.#sInventoryBase) return this.#sInventoryBase;
            const sPlant = PodContext.getPlant();
            const sMs    = ApiPaths.INVENTORY_MS_PATH;   // "dme/inventory-ms"
            const aCandidates = [
                sMs + "/inventory/v1/inventories",
                sMs + "/inventory/v2/inventories",
                sMs + "/v1/inventories",
                sMs + "/v2/inventories",
                sMs + "/inventories",
                sMs + "/api/v1/inventories",
                sMs + "/api/inventory/v1/inventories"
            ];
            for (const sBase of aCandidates) {
                try {
                    const oResult = await RestClient.get(sBase, { plant: sPlant, size: 1 });
                    // Must look like a real inventory response, else it's a shell/fallback 200.
                    const bReal = oResult && (Array.isArray(oResult.content) || Array.isArray(oResult)
                        || (oResult.inventoryId !== undefined));
                    if (bReal) {
                        this.#sInventoryBase = sBase;
                        this.#oLog.info("Resolved inventory REST base: " + sBase);
                        return sBase;
                    }
                    this.#oLog.debug("Candidate returned non-inventory 200 (ignored): " + sBase);
                } catch (oErr) {
                    this.#oLog.debug("Inventory base candidate failed: " + sBase, oErr);
                }
            }
            return null;
        }

        async _executeScrap(oItem, fQuantity) {
            if (this.#oTable) this.#oTable.setBusy(true);
            try {
                const sPlant = PodContext.getPlant();

                const sBase = await this._resolveInventoryBase();
                if (!sBase) {
                    throw new Error("Could not resolve the inventory service endpoint for scrap.");
                }
                const sUrl = sBase
                    + "/" + encodeURIComponent(oItem.inventoryId)
                    + "/scrap?plant=" + encodeURIComponent(sPlant);

                // Send the stock's ACTUAL unit of measure (all forms it carries) rather than a
                // guessed default — the service resolves the UOM's representation from this, and a
                // wrong/empty UOM is what triggers "EntityRepresentationModel not found".
                const oStockUom = oItem.quantityOnHand?.unitOfMeasure || {};
                const oReqUom = {};
                if (oStockUom.internalUnitOfMeasure)   oReqUom.internalUnitOfMeasure   = oStockUom.internalUnitOfMeasure;
                if (oStockUom.isoUnitOfMeasure)        oReqUom.isoUnitOfMeasure        = oStockUom.isoUnitOfMeasure;
                if (oStockUom.commercialUnitOfMeasure) oReqUom.commercialUnitOfMeasure = oStockUom.commercialUnitOfMeasure;

                const oPayload = {
                    quantity: {
                        value: fQuantity,
                        unitOfMeasure: oReqUom
                    }
                };

                await RestClient.post(sUrl, oPayload);

                MessageHistory.showSuccess(this.getI18nText("message.scrapSuccess"));
                const sMat = this.#sMaterial
                    || (this.#oMaterialInput && this.#oMaterialInput.getValue().trim().split(" / ")[0].trim())
                    || "";
                const aItems = await this._fetchInventory(sMat, this.#sVersion || "");
                this._populateTable(aItems);

            } finally {
                if (this.#oTable) this.#oTable.setBusy(false);
            }
        }
    }

    return ScrapInventory;
});
