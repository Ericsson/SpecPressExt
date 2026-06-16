const vscode = require('vscode')

class BcFilterViewProvider {
  constructor(bcTreeProvider) {
    this.bcTreeProvider = bcTreeProvider
  }

  resolveWebviewView(webviewView, context, token) {
    this.view = webviewView

    webviewView.webview.options = {
      enableScripts: true
    }

    webviewView.webview.html = this.getHtmlContent()

    webviewView.webview.onDidReceiveMessage(message => {
      switch (message.command) {
        case 'filter':
          // Disable filter button and show processing state
          webviewView.webview.postMessage({ command: 'filterStart' })

          // Use setTimeout to allow UI to update before heavy operation
          setTimeout(async () => {
            await this.bcTreeProvider.setFilters(
              message.bcId,
              message.bands,
              message.bandsMode,
              message.carriers,
              message.carriersMode,
              message.properties,
              message.modifiedOnly,
              message.ulNotes,
              message.dlNotes
            )

            // Re-enable filter button
            webviewView.webview.postMessage({ command: 'filterComplete' })
          }, 10)
          break
        case 'clear':
          this.bcTreeProvider.setFilters('', [], 'atLeast', '', 'exactly', [], false, [], [])
          webviewView.webview.html = this.getHtmlContent()
          break
        case 'toggleType':
          this.bcTreeProvider.setTypeFilters(
            message.loadCA,
            message.loadDC,
            message.loadBands
          )
          break
        case 'getBands':
          const bands = this.bcTreeProvider.getAllBands()
          const query = (message.query || '').toLowerCase()
          const filtered = bands.filter(b => b.toLowerCase().includes(query))
          webviewView.webview.postMessage({ command: 'bandsResult', bands: filtered })
          break
      }
    })
  }

  getHtmlContent() {
    return `<!DOCTYPE html>
<html>
<head>
  <style>
    body {
      padding: 10px;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }
    .filter-group {
      margin-bottom: 12px;
    }
    label {
      display: block;
      margin-bottom: 4px;
      font-weight: 500;
    }
    input {
      width: 100%;
      padding: 4px 8px;
      box-sizing: border-box;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border);
    }
    input:focus {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: -1px;
    }
    .toggle-group {
      margin-bottom: 16px;
    }
    .toggle-buttons {
      display: flex;
      gap: 8px;
      margin-top: 8px;
    }
    .toggle-btn {
      flex: 1;
      padding: 6px 12px;
      border: 1px solid var(--vscode-button-border);
      cursor: pointer;
      text-align: center;
      border-radius: 3px;
      font-size: 12px;
      transition: all 0.2s;
    }
    .toggle-btn.active {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border-color: var(--vscode-button-background);
    }
    .toggle-btn.inactive {
      background: var(--vscode-input-background);
      color: var(--vscode-descriptionForeground);
      opacity: 0.6;
    }
    .toggle-btn:hover {
      opacity: 1;
    }
    .git-status-line {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 12px;
    }
    .git-status-line label {
      margin-bottom: 0;
      min-width: auto;
    }
    .git-status-line .toggle-btn {
      flex: 1; // 0 0 auto;
    }
    .band-input-container {
      position: relative;
    }
    .band-chips {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      margin-bottom: 6px;
      min-height: 0;
    }
    .band-chips:not(:empty) {
      min-height: 24px;
    }
    .band-chip {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 2px 6px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      border-radius: 3px;
      font-size: 11px;
    }
    .band-chip-remove {
      cursor: pointer;
      font-weight: bold;
    }
    .band-autocomplete {
      position: absolute;
      top: 100%;
      left: 0;
      right: 0;
      max-height: 150px;
      overflow-y: auto;
      background: var(--vscode-dropdown-background);
      border: 1px solid var(--vscode-dropdown-border);
      z-index: 1000;
      display: none;
    }
    .band-autocomplete.show {
      display: block;
    }
    .band-option {
      padding: 4px 8px;
      cursor: pointer;
    }
    .band-option:hover,
    .band-option.selected {
      background: var(--vscode-list-hoverBackground);
    }
    .band-mode-toggle {
      display: flex;
      gap: 4px;
      margin-top: 6px;
    }
    .band-mode-btn {
      flex: 1;
      padding: 4px 8px;
      border: 1px solid var(--vscode-button-border);
      cursor: pointer;
      text-align: center;
      border-radius: 3px;
      font-size: 11px;
      background: var(--vscode-input-background);
      color: var(--vscode-descriptionForeground);
    }
    .band-mode-btn.active {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .button-group {
      display: flex;
      gap: 8px;
      margin-top: 12px;
    }
    button {
      flex: 1;
      padding: 6px 12px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      cursor: pointer;
    }
    button:hover {
      background: var(--vscode-button-hoverBackground);
    }
    button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    button.processing {
      background: var(--vscode-editorWarning-foreground);
      color: var(--vscode-editor-background);
    }
    button.secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    button.secondary:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }
  </style>
</head>
<body>
  <div class="toggle-group">
    <label>File Types:</label>
    <div class="toggle-buttons">
      <div class="toggle-btn active" id="typeToggleCA" data-type="CA">CA</div>
      <div class="toggle-btn inactive" id="typeToggleDC" data-type="DC">DC</div>
      <div class="toggle-btn active" id="typeToggleBands" data-type="Bands">Bands</div>
    </div>
  </div>

  <div class="git-status-line">
    <label>Git Status:</label>
    <div class="toggle-btn inactive" id="gitModifiedOnly" data-git="modifiedOnly">Modified only</div>
  </div>

  <div class="filter-group">
    <label for="filterBcId">BC ID (exact):</label>
    <input type="text" id="filterBcId" placeholder="e.g., CA_n1A-n78C" />
  </div>

  <div class="filter-group">
    <label>Band Numbers:</label>
    <div class="band-chips" id="filterBandChips"></div>
    <div class="band-input-container">
      <input type="text" id="filterBandInput" placeholder="Type band number (e.g., n78)" />
      <div class="band-autocomplete" id="filterBandAutocomplete"></div>
    </div>
    <div class="band-mode-toggle">
      <div class="band-mode-btn" id="bandModeOnly">Only</div>
      <div class="band-mode-btn active" id="bandModeAtLeast">At Least</div>
    </div>
  </div>

  <div class="filter-group">
    <label>UL Notes:</label>
    <div class="band-chips" id="filterUlNotesChips"></div>
    <div class="band-input-container">
      <input type="text" id="filterUlNotesInput" placeholder="Type UL note (e.g., pc2)" />
      <div class="band-autocomplete" id="filterUlNotesAutocomplete"></div>
    </div>
  </div>

  <div class="filter-group">
    <label>DL Notes:</label>
    <div class="band-chips" id="filterDlNotesChips"></div>
    <div class="band-input-container">
      <input type="text" id="filterDlNotesInput" placeholder="Type DL note (e.g., intraReq)" />
      <div class="band-autocomplete" id="filterDlNotesAutocomplete"></div>
    </div>
  </div>

  <div class="filter-group">
    <label>Number of Carriers:</label>
    <input type="number" id="filterCarriers" placeholder="e.g., 2" min="1" />
    <div class="band-mode-toggle" style="margin-top: 6px;">
      <div class="band-mode-btn active" id="carrierModeExactly">Exactly</div>
      <div class="band-mode-btn" id="carrierModeAtLeast">At Least</div>
      <div class="band-mode-btn" id="carrierModeUpTo">Up To</div>
    </div>
  </div>

  <div class="toggle-group">
    <label>Properties:</label>
    <div class="toggle-buttons">
      <div class="toggle-btn" id="propIntraBand" data-prop="intraBand">Intra</div>
      <div class="toggle-btn" id="propFr1" data-prop="fr1">FR1</div>
      <div class="toggle-btn" id="propFr2" data-prop="fr2">FR2</div>
      <div class="toggle-btn" id="propNR" data-prop="nr">NR</div>
      <div class="toggle-btn" id="propSUL" data-prop="sul">SUL</div>
    </div>
  </div>

  <div class="button-group">
    <button id="actionFilterBtn">Filter</button>
    <button id="actionClearBtn" class="secondary">Clear</button>
  </div>

  <script>
    const vscode = acquireVsCodeApi();

    const filterBcIdInput = document.getElementById('filterBcId');
    const filterBandInput = document.getElementById('filterBandInput');
    const filterBandChips = document.getElementById('filterBandChips');
    const filterBandAutocomplete = document.getElementById('filterBandAutocomplete');
    const filterUlNotesInput = document.getElementById('filterUlNotesInput');
    const filterUlNotesChips = document.getElementById('filterUlNotesChips');
    const filterUlNotesAutocomplete = document.getElementById('filterUlNotesAutocomplete');
    const filterDlNotesInput = document.getElementById('filterDlNotesInput');
    const filterDlNotesChips = document.getElementById('filterDlNotesChips');
    const filterDlNotesAutocomplete = document.getElementById('filterDlNotesAutocomplete');
    const bandModeOnly = document.getElementById('bandModeOnly');
    const bandModeAtLeast = document.getElementById('bandModeAtLeast');
    const filterCarriersInput = document.getElementById('filterCarriers');
    const carrierModeExactly = document.getElementById('carrierModeExactly');
    const carrierModeAtLeast = document.getElementById('carrierModeAtLeast');
    const carrierModeUpTo = document.getElementById('carrierModeUpTo');
    const actionFilterBtn = document.getElementById('actionFilterBtn');
    const actionClearBtn = document.getElementById('actionClearBtn');

    let typeState = { CA: true, DC: false, Bands: true };
    let propState = { intraBand: false, fr1: false, fr2: false, nr: false, sul: false };
    let modifiedOnly = false;
    let selectedBands = [];
    let selectedUlNotes = [];
    let selectedDlNotes = [];
    let bandsMode = 'atLeast';
    let carriersMode = 'exactly';
    let availableBands = [];
    let availableUlNotes = ['fLim3450_3700', 'n5A-n8A_restrictions', 'n26_DualPA', 'pc1p5', 'pc1p5_2tx', 'pc1p5_3tx', 'pc2', 'pc2_2tx', 'pc2_3tx', 'Rel-18_800MHzUL', 'ul_n5', 'ul_n26_opt'];
    let availableDlNotes = ['intraReq', 'lowBandSwitchingAllowed', 'lowBandSwitchingOnly', 'n7_n38', 'n28_703U_758D', 'n28_718U_773D', 'n77_RxTx', 'noSimRxTx', 'noSimRxTx_noRxSensitivitySection', 'psdi_6dB', 'psdi_6dB_r19', 'Rel-18_1600MHzDL', 'ul_n28'];
    let ulNotesSelectedIndex = -1;
    let dlNotesSelectedIndex = -1;
    const typeToggleCA = document.getElementById('typeToggleCA');
    const typeToggleDC = document.getElementById('typeToggleDC');
    const typeToggleBands = document.getElementById('typeToggleBands');
    const propIntraBand = document.getElementById('propIntraBand');
    const propFr1 = document.getElementById('propFr1');
    const propFr2 = document.getElementById('propFr2');
    const propNR = document.getElementById('propNR');
    const propSUL = document.getElementById('propSUL');
    const gitModifiedOnly = document.getElementById('gitModifiedOnly');

    function updateToggleState(button, isActive) {
      if (isActive) {
        button.classList.remove('inactive');
        button.classList.add('active');
      } else {
        button.classList.remove('active');
        button.classList.add('inactive');
      }
    }

    function handleToggle(button, type) {
      typeState[type] = !typeState[type];
      updateToggleState(button, typeState[type]);

      vscode.postMessage({
        command: 'toggleType',
        loadCA: typeState.CA,
        loadDC: typeState.DC,
        loadBands: typeState.Bands
      });
    }

    typeToggleCA.addEventListener('click', () => handleToggle(typeToggleCA, 'CA'));
    typeToggleDC.addEventListener('click', () => handleToggle(typeToggleDC, 'DC'));
    typeToggleBands.addEventListener('click', () => handleToggle(typeToggleBands, 'Bands'));

    function handlePropToggle(button, prop) {
      propState[prop] = !propState[prop];
      updateToggleState(button, propState[prop]);
      applyFilter();
    }

    propIntraBand.addEventListener('click', () => handlePropToggle(propIntraBand, 'intraBand'));
    propFr1.addEventListener('click', () => handlePropToggle(propFr1, 'fr1'));
    propFr2.addEventListener('click', () => handlePropToggle(propFr2, 'fr2'));
    propNR.addEventListener('click', () => handlePropToggle(propNR, 'nr'));
    propSUL.addEventListener('click', () => handlePropToggle(propSUL, 'sul'));

    gitModifiedOnly.addEventListener('click', () => {
      modifiedOnly = !modifiedOnly;
      updateToggleState(gitModifiedOnly, modifiedOnly);
      applyFilter();
    });

    function renderBandChips() {
      filterBandChips.innerHTML = selectedBands.map(band =>
        \`<div class="band-chip">
          <span>\${band}</span>
          <span class="band-chip-remove" data-band="\${band}">×</span>
        </div>\`
      ).join('');

      filterBandChips.querySelectorAll('.band-chip-remove').forEach(btn => {
        btn.addEventListener('click', (e) => {
          const band = e.target.getAttribute('data-band');
          selectedBands = selectedBands.filter(b => b !== band);
          renderBandChips();
        });
      });
    }

    function renderUlNotesChips() {
      filterUlNotesChips.innerHTML = selectedUlNotes.map(note =>
        \`<div class="band-chip">
          <span>\${note}</span>
          <span class="band-chip-remove" data-note="\${note}">×</span>
        </div>\`
      ).join('');

      filterUlNotesChips.querySelectorAll('.band-chip-remove').forEach(btn => {
        btn.addEventListener('click', (e) => {
          const note = e.target.getAttribute('data-note');
          selectedUlNotes = selectedUlNotes.filter(n => n !== note);
          renderUlNotesChips();
        });
      });
    }

    function renderDlNotesChips() {
      filterDlNotesChips.innerHTML = selectedDlNotes.map(note =>
        \`<div class="band-chip">
          <span>\${note}</span>
          <span class="band-chip-remove" data-note="\${note}">×</span>
        </div>\`
      ).join('');

      filterDlNotesChips.querySelectorAll('.band-chip-remove').forEach(btn => {
        btn.addEventListener('click', (e) => {
          const note = e.target.getAttribute('data-note');
          selectedDlNotes = selectedDlNotes.filter(n => n !== note);
          renderDlNotesChips();
        });
      });
    }

    function addBand(band) {
      if (band && !selectedBands.includes(band)) {
        selectedBands.push(band);
        renderBandChips();
      }
      filterBandInput.value = '';
      filterBandAutocomplete.classList.remove('show');
    }

    function addUlNote(note) {
      if (note && !selectedUlNotes.includes(note)) {
        selectedUlNotes.push(note);
        renderUlNotesChips();
      }
      filterUlNotesInput.value = '';
      ulNotesSelectedIndex = -1;
      filterUlNotesAutocomplete.classList.remove('show');
    }

    function updateUlNotesSelection(options) {
      options.forEach((opt, idx) => {
        if (idx === ulNotesSelectedIndex) {
          opt.classList.add('selected');
        } else {
          opt.classList.remove('selected');
        }
      });
    }

    function addDlNote(note) {
      if (note && !selectedDlNotes.includes(note)) {
        selectedDlNotes.push(note);
        renderDlNotesChips();
      }
      filterDlNotesInput.value = '';
      dlNotesSelectedIndex = -1;
      filterDlNotesAutocomplete.classList.remove('show');
    }

    function updateDlNotesSelection(options) {
      options.forEach((opt, idx) => {
        if (idx === dlNotesSelectedIndex) {
          opt.classList.add('selected');
        } else {
          opt.classList.remove('selected');
        }
      });
    }

    function updateAutocomplete(query) {
      if (!query) {
        filterBandAutocomplete.classList.remove('show');
        return;
      }

      vscode.postMessage({ command: 'getBands', query });
    }

    function updateUlNotesAutocomplete(query) {
      const lowerQuery = (query || '').toLowerCase();
      const filtered = availableUlNotes.filter(n => !selectedUlNotes.includes(n) && n.toLowerCase().includes(lowerQuery));

      if (filtered.length > 0) {
        filterUlNotesAutocomplete.innerHTML = filtered.map((note, idx) =>
          \`<div class="band-option" data-note="\${note}" data-index="\${idx}">\${note}</div>\`
        ).join('');

        filterUlNotesAutocomplete.querySelectorAll('.band-option').forEach(opt => {
          opt.addEventListener('click', (e) => {
            addUlNote(e.target.getAttribute('data-note'));
          });
        });

        filterUlNotesAutocomplete.classList.add('show');
      } else {
        filterUlNotesAutocomplete.classList.remove('show');
      }
    }

    function updateDlNotesAutocomplete(query) {
      const lowerQuery = (query || '').toLowerCase();
      const filtered = availableDlNotes.filter(n => !selectedDlNotes.includes(n) && n.toLowerCase().includes(lowerQuery));

      if (filtered.length > 0) {
        filterDlNotesAutocomplete.innerHTML = filtered.map((note, idx) =>
          \`<div class="band-option" data-note="\${note}" data-index="\${idx}">\${note}</div>\`
        ).join('');

        filterDlNotesAutocomplete.querySelectorAll('.band-option').forEach(opt => {
          opt.addEventListener('click', (e) => {
            addDlNote(e.target.getAttribute('data-note'));
          });
        });

        filterDlNotesAutocomplete.classList.add('show');
      } else {
        filterDlNotesAutocomplete.classList.remove('show');
      }
    }

    window.addEventListener('message', event => {
      const message = event.data;
      if (message.command === 'bandsResult') {
        availableBands = message.bands.filter(b => !selectedBands.includes(b));

        if (availableBands.length > 0) {
          filterBandAutocomplete.innerHTML = availableBands.slice(0, 10).map(band =>
            \`<div class="band-option" data-band="\${band}">\${band}</div>\`
          ).join('');

          filterBandAutocomplete.querySelectorAll('.band-option').forEach(opt => {
            opt.addEventListener('click', (e) => {
              addBand(e.target.getAttribute('data-band'));
            });
          });

          filterBandAutocomplete.classList.add('show');
        } else {
          filterBandAutocomplete.classList.remove('show');
        }
      } else if (message.command === 'filterStart') {
        actionFilterBtn.disabled = true;
        actionFilterBtn.classList.add('processing');
        actionFilterBtn.textContent = 'Processing...';
      } else if (message.command === 'filterComplete') {
        actionFilterBtn.disabled = false;
        actionFilterBtn.classList.remove('processing');
        actionFilterBtn.textContent = 'Filter';
      }
    });

    filterBandInput.addEventListener('input', (e) => {
      updateAutocomplete(e.target.value);
    });

    filterBandInput.addEventListener('focus', () => {
      updateAutocomplete(filterBandInput.value);
    });

    filterBandInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (availableBands.length > 0) {
          addBand(availableBands[0]);
        } else {
          addBand(filterBandInput.value.trim());
        }
      }
    });

    filterBandInput.addEventListener('blur', () => {
      setTimeout(() => filterBandAutocomplete.classList.remove('show'), 200);
    });

    filterUlNotesInput.addEventListener('input', (e) => {
      ulNotesSelectedIndex = -1;
      updateUlNotesAutocomplete(e.target.value);
    });

    filterUlNotesInput.addEventListener('focus', () => {
      ulNotesSelectedIndex = -1;
      updateUlNotesAutocomplete(filterUlNotesInput.value);
    });

    filterUlNotesInput.addEventListener('keydown', (e) => {
      const options = filterUlNotesAutocomplete.querySelectorAll('.band-option');
      if (options.length === 0) return;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        ulNotesSelectedIndex = Math.min(ulNotesSelectedIndex + 1, options.length - 1);
        updateUlNotesSelection(options);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        ulNotesSelectedIndex = Math.max(ulNotesSelectedIndex - 1, -1);
        updateUlNotesSelection(options);
      }
    });

    filterUlNotesInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const options = filterUlNotesAutocomplete.querySelectorAll('.band-option');
        if (ulNotesSelectedIndex >= 0 && ulNotesSelectedIndex < options.length) {
          addUlNote(options[ulNotesSelectedIndex].getAttribute('data-note'));
        } else if (options.length > 0) {
          addUlNote(options[0].getAttribute('data-note'));
        }
      }
    });

    filterUlNotesInput.addEventListener('blur', () => {
      setTimeout(() => filterUlNotesAutocomplete.classList.remove('show'), 200);
    });

    filterDlNotesInput.addEventListener('input', (e) => {
      dlNotesSelectedIndex = -1;
      updateDlNotesAutocomplete(e.target.value);
    });

    filterDlNotesInput.addEventListener('focus', () => {
      dlNotesSelectedIndex = -1;
      updateDlNotesAutocomplete(filterDlNotesInput.value);
    });

    filterDlNotesInput.addEventListener('keydown', (e) => {
      const options = filterDlNotesAutocomplete.querySelectorAll('.band-option');
      if (options.length === 0) return;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        dlNotesSelectedIndex = Math.min(dlNotesSelectedIndex + 1, options.length - 1);
        updateDlNotesSelection(options);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        dlNotesSelectedIndex = Math.max(dlNotesSelectedIndex - 1, -1);
        updateDlNotesSelection(options);
      }
    });

    filterDlNotesInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const options = filterDlNotesAutocomplete.querySelectorAll('.band-option');
        if (dlNotesSelectedIndex >= 0 && dlNotesSelectedIndex < options.length) {
          addDlNote(options[dlNotesSelectedIndex].getAttribute('data-note'));
        } else if (options.length > 0) {
          addDlNote(options[0].getAttribute('data-note'));
        }
      }
    });

    filterDlNotesInput.addEventListener('blur', () => {
      setTimeout(() => filterDlNotesAutocomplete.classList.remove('show'), 200);
    });

    bandModeOnly.addEventListener('click', () => {
      bandsMode = 'only';
      bandModeOnly.classList.add('active');
      bandModeAtLeast.classList.remove('active');
      if (selectedBands.length > 0) applyFilter();
    });

    bandModeAtLeast.addEventListener('click', () => {
      bandsMode = 'atLeast';
      bandModeAtLeast.classList.add('active');
      bandModeOnly.classList.remove('active');
      applyFilter();
    });

    carrierModeExactly.addEventListener('click', () => {
      carriersMode = 'exactly';
      carrierModeExactly.classList.add('active');
      carrierModeAtLeast.classList.remove('active');
      carrierModeUpTo.classList.remove('active');
      if (filterCarriersInput.value) applyFilter();
    });

    carrierModeAtLeast.addEventListener('click', () => {
      carriersMode = 'atLeast';
      carrierModeAtLeast.classList.add('active');
      carrierModeExactly.classList.remove('active');
      carrierModeUpTo.classList.remove('active');
      if (filterCarriersInput.value) applyFilter();
    });

    carrierModeUpTo.addEventListener('click', () => {
      carriersMode = 'upTo';
      carrierModeUpTo.classList.add('active');
      carrierModeExactly.classList.remove('active');
      carrierModeAtLeast.classList.remove('active');
      if (filterCarriersInput.value) applyFilter();
    });

    function applyFilter() {
      const activeProps = Object.keys(propState).filter(k => propState[k]);
      vscode.postMessage({
        command: 'filter',
        bcId: filterBcIdInput.value,
        bands: selectedBands,
        bandsMode: bandsMode,
        carriers: filterCarriersInput.value,
        carriersMode: carriersMode,
        properties: activeProps,
        modifiedOnly: modifiedOnly,
        ulNotes: selectedUlNotes,
        dlNotes: selectedDlNotes
      });
    }

    actionFilterBtn.addEventListener('click', applyFilter);
    actionClearBtn.addEventListener('click', () => {
      filterBcIdInput.value = '';
      selectedBands = [];
      selectedUlNotes = [];
      selectedDlNotes = [];
      bandsMode = 'atLeast';
      bandModeAtLeast.classList.add('active');
      bandModeOnly.classList.remove('active');
      carriersMode = 'exactly';
      carrierModeExactly.classList.add('active');
      carrierModeAtLeast.classList.remove('active');
      carrierModeUpTo.classList.remove('active');
      filterCarriersInput.value = '';
      propState = { intraBand: false, fr1: false, fr2: false, nr: false, sul: false };
      updateToggleState(propIntraBand, false);
      updateToggleState(propFr1, false);
      updateToggleState(propFr2, false);
      updateToggleState(propNR, false);
      updateToggleState(propSUL, false);
      modifiedOnly = false;
      updateToggleState(gitModifiedOnly, false);
      renderBandChips();
      renderUlNotesChips();
      renderDlNotesChips();
      vscode.postMessage({ command: 'clear' });
    });

    filterBcIdInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') applyFilter();
    });
    filterCarriersInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') applyFilter();
    });
  </script>
</body>
</html>`
  }
}

module.exports = { BcFilterViewProvider }
