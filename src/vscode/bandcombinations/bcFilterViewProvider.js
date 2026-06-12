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
              message.modifiedOnly
            )
            
            // Re-enable filter button
            webviewView.webview.postMessage({ command: 'filterComplete' })
          }, 10)
          break
        case 'clear':
          this.bcTreeProvider.setFilters('', [], 'atLeast', '', 'exactly', [], false)
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
      flex: 0 0 auto;
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
    .band-option:hover {
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
    <div class="toggle-btn" id="gitModifiedOnly" data-git="modifiedOnly">Modified only</div>
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
    let bandsMode = 'atLeast';
    let carriersMode = 'exactly';
    let availableBands = [];
    
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
    
    function addBand(band) {
      if (band && !selectedBands.includes(band)) {
        selectedBands.push(band);
        renderBandChips();
      }
      filterBandInput.value = '';
      filterBandAutocomplete.classList.remove('show');
    }
    
    function updateAutocomplete(query) {
      if (!query) {
        filterBandAutocomplete.classList.remove('show');
        return;
      }
      
      vscode.postMessage({ command: 'getBands', query });
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
        modifiedOnly: modifiedOnly
      });
    }
    
    actionFilterBtn.addEventListener('click', applyFilter);
    actionClearBtn.addEventListener('click', () => {
      filterBcIdInput.value = '';
      selectedBands = [];
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
