// Monitor Dashboard Mode — full TUI dashboard for Ponyou monitoring
// Activated via /monitor command from Agent REPL

import blessed from 'blessed';
import { readPonyouState, getPonyouTools } from '../data/state-bridge.js';

export function createMonitorScreen(screen, { onBack }) {
  const rows = screen.rows;
  const cols = screen.cols;

  // State
  let paused = false;
  let showHelp = false;
  let selectedChartToken = 'WIF2';
  let logLines = [];
  let logFilter = 'all';

  // ── Helpers ──
  function pad(s, len) { return String(s||'').padEnd(len).slice(0,len); }
  function now() { return new Date().toTimeString().slice(0,8); }

  // Mock log generator
  const LOG_TEMPLATES = [
    () => ({ level:'SCAN', module:'token_scanner', msg:`scan cycle — screening new pairs on Solana` }),
    () => ({ level:'RISK', module:'rug_check', msg:`evaluating token safety scores` }),
    () => ({ level:'SIGNAL', module:'signal_parser', msg:`checking telegram/discord channels for signals` }),
    () => ({ level:'DEX', module:'jupiter_quote_monitor', msg:`fetching quotes from Jupiter API` }),
    () => ({ level:'INFO', module:'agent', msg:`health check passed — all systems nominal` }),
    () => ({ level:'SYSTEM', module:'core', msg:`state saved — ${now()}` }),
    () => ({ level:'TOOL', module:'narrative_detector', msg:`scanning narratives: AI, gaming, dePIN, meme L2` }),
    () => ({ level:'WALLET', module:'wallet_tracker', msg:`monitoring smart wallet activity` }),
  ];

  function genLog() {
    const t = LOG_TEMPLATES[Math.floor(Math.random() * LOG_TEMPLATES.length)]();
    t.time = now();
    logLines.push(t);
    if (logLines.length > 300) logLines = logLines.slice(-300);
  }

  // Initial logs
  for (let i = 0; i < 20; i++) genLog();

  // ── Layout ──
  const headerH = 7, footerH = 2, mainTop = headerH, mainH = rows - headerH - footerH;
  const leftW = Math.floor(cols * 0.25), rightW = Math.floor(cols * 0.28), centerW = cols - leftW - rightW;
  const leftH1 = 7, leftH2 = 10, leftH3 = mainH - leftH1 - leftH2;
  const rightH1 = Math.floor(mainH * 0.30), rightH2 = Math.floor(mainH * 0.38), rightH3 = mainH - rightH1 - rightH2;

  // ── Widgets ──
  const header = blessed.box({ top:0, left:0, width:cols, height:headerH, tags:true, border:{type:'line',fg:'white'}, style:{fg:'white',border:{fg:'white'},label:{fg:'white'}} });
  const agentBox = blessed.box({ top:mainTop, left:0, width:leftW, height:leftH1, tags:true, label:' Agent ', border:{type:'line',fg:'white'}, style:{fg:'white',border:{fg:'white'},label:{fg:'white'}} });
  const toolsBox = blessed.box({ top:mainTop+leftH1, left:0, width:leftW, height:leftH2, tags:true, label:' Tools ', border:{type:'line',fg:'white'}, style:{fg:'white',border:{fg:'white'},label:{fg:'white'}}, scrollable:true, keys:true, vi:true });
  const posBox = blessed.box({ top:mainTop+leftH1+leftH2, left:0, width:leftW, height:leftH3, tags:true, label:' Positions ', border:{type:'line',fg:'white'}, style:{fg:'white',border:{fg:'white'},label:{fg:'white'}} });
  const logBox = blessed.box({ top:mainTop, left:leftW, width:centerW, height:mainH, tags:true, label:' Logs ', border:{type:'line',fg:'white'}, style:{fg:'white',border:{fg:'white'},label:{fg:'white'}}, scrollable:true, alwaysScroll:true, keys:true, vi:true, mouse:true });
  const chartBox = blessed.box({ top:mainTop, left:leftW+centerW, width:rightW, height:rightH1, tags:true, label:' Chart ', border:{type:'line',fg:'white'}, style:{fg:'white',border:{fg:'white'},label:{fg:'white'}} });
  const marketBox = blessed.box({ top:mainTop+rightH1, left:leftW+centerW, width:rightW, height:rightH2, tags:true, label:' Market Scan ', border:{type:'line',fg:'white'}, style:{fg:'white',border:{fg:'white'},label:{fg:'white'}} });
  const riskBox = blessed.box({ top:mainTop+rightH1+rightH2, left:leftW+centerW, width:rightW, height:rightH3, tags:true, label:' Alerts ', border:{type:'line',fg:'white'}, style:{fg:'white',border:{fg:'white'},label:{fg:'white'}} });
  const footer = blessed.box({ top:rows-footerH, left:0, width:cols, height:footerH, tags:true, style:{fg:'white'} });
  const helpBox = blessed.box({ top:'center', left:'center', width:46, height:16, tags:true, border:{type:'line',fg:'white'}, style:{fg:'white',border:{fg:'white'},label:{fg:'white'}}, hidden:true });

  [header,agentBox,toolsBox,posBox,logBox,chartBox,marketBox,riskBox,footer,helpBox].forEach(w => screen.append(w));

  // ── Renderers ──
  function renderAll() {
    const s = readPonyouState();
    const tools = getPonyouTools();

    // Header
    const balC = s.balance > 0 ? 'green' : 'yellow';
    const pnlC = s.dailyPnl >= 0 ? 'green' : 'red', pnlS = s.dailyPnl >= 0 ? '+' : '';
    const modeC = s.mode === 'live' ? 'green' : s.mode === 'paper' ? 'yellow' : 'gray';
    header.setContent([
      ` {yellow-fg}╔═╗ ╔═╗ ╔╗╔ ╦ ╦ ╔═╗ ╦ ╦   ╔═╗ ╔═╗ ╔═╗ ╔╗╔ ╔╦╗{/yellow-fg}`,
      ` {yellow-fg}╠═╝ ║ ║ ║║║ ╚╦╝ ║ ║ ║ ║   ╠═╣ ║ ╦ ║╣  ║║║  ║ {/yellow-fg}`,
      ` {yellow-fg}╩   ╚═╝ ╝╚╝  ╩  ╚═╝ ╚═╝   ╩ ╩ ╚═╝ ╚═╝ ╝╚╝  ╩ {/yellow-fg}`,
      ` {${modeC}-fg}${s.mode.toUpperCase()}{/${modeC}-fg}  {white-fg}·{/white-fg}  {white-fg}↑ ${Math.floor(s.uptime/3600)}h${Math.floor((s.uptime%3600)/60)}m{/white-fg}  {white-fg}·{/white-fg}  {green-fg}${s.walletStatus}{/green-fg}`,
      ` {#888888-fg}session: ${s.sessionId || 'new'}  ·  network Solana  ·  monitor active{/#888888-fg}`,
    ].join('\n'));

    // Agent
    const riskC = s.riskLevel === 'LOW' ? 'green' : s.riskLevel === 'MEDIUM' ? 'yellow' : 'red';
    agentBox.setContent([
      `{white-fg}Agent:    {cyan-fg}${s.agentName}{/cyan-fg}`,
      `{white-fg}Strategy: {magenta-fg}${s.strategy}{/magenta-fg}`,
      `{white-fg}Mode:     {green-fg}${s.mode.toUpperCase()}{/green-fg}`,
      `{white-fg}Balance:  {${balC}-fg}${s.balance.toFixed(2)} SOL{/${balC}-fg}`,
      `{white-fg}Positions:{cyan-fg} ${s.openPositions}{/cyan-fg}`,
      `{white-fg}Win Rate: {green-fg}${(s.winRate*100).toFixed(1)}%{/green-fg}`,
      `{white-fg}Daily PnL:{${pnlC}-fg} ${pnlS}${s.dailyPnl.toFixed(2)} SOL{/${pnlC}-fg}`,
      `{white-fg}Risk:     {${riskC}-fg}${s.riskLevel}{/${riskC}-fg}`,
    ].join('\n'));

    // Tools
    toolsBox.setContent(tools.map(t => {
      const c = t.status === 'READY' ? 'green' : t.status === 'SYNCING' ? 'cyan' : t.status === 'RATE_LIMIT' ? 'yellow' : 'red';
      return `{white-fg}${pad(t.name,22)}{/white-fg} {${c}-fg}${pad(t.status,11)}{/${c}-fg}`;
    }).join('\n'));

    // Positions
    const pos = s.openPositionsList;
    if (pos.length === 0) {
      posBox.setContent('{gray-fg}No open positions{/gray-fg}');
    } else {
      const hdr = '{gray-fg}' + pad('Sym',7)+' '+pad('Entry',10)+' '+pad('PnL%',9)+' '+pad('Size',7)+' '+pad('Risk',5)+'{/gray-fg}';
      const rows = pos.map(p => {
        const pC = p.pnlPct >= 0 ? 'green' : 'red', pS = p.pnlPct >= 0 ? '+' : '';
        const rC = p.risk === 'LOW' ? 'green' : p.risk === 'MED' ? 'yellow' : 'red';
        return `{white-fg}${pad(p.sym,7)} ${pad(String(p.entry),10)} {${pC}-fg}${pS}${p.pnlPct.toFixed(1)}%{/${pC}-fg}  ${pad(p.size.toFixed(2),7)} {${rC}-fg}${pad(p.risk,5)}{/${rC}-fg}{/white-fg}`;
      });
      posBox.setContent(hdr + '\n' + rows.join('\n'));
    }

    // Logs
    const filtered = logFilter === 'all' ? logLines : logLines.filter(l => l.level === logFilter.toUpperCase());
    logBox.setLabel({ text: paused ? ' Logs · PAUSED ' : ` Logs · ${logFilter === 'all' ? 'all' : logFilter.toLowerCase()} `, side: 'left' });
    logBox.setContent(filtered.slice(-60).map(l => {
      const c = {INFO:'white',SCAN:'cyan',SIGNAL:'yellow',TRADE:'magenta',RISK:'red',WARN:'yellow',ERROR:'red',SYSTEM:'green',TOOL:'blue',DEX:'cyan',WALLET:'green'}[l.level]||'white';
      return `{gray-fg}${l.time}{/gray-fg} {${c}-fg}${pad(l.level,6)}{/${c}-fg} {white-fg}${pad(l.module,22)}{/white-fg} ${l.msg}`;
    }).join('\n'));
    if (!paused) logBox.setScrollPerc(100);

    // Chart (mini spark)
    const sparkChars = ['▁','▂','▃','▄','▅','▆','▇','█'];
    const pts = Array.from({length:18},() => Math.random());
    const mx = Math.max(...pts), mn = Math.min(...pts), rng = mx-mn||1;
    const spark = pts.map(p => sparkChars[Math.min(7,Math.floor(((p-mn)/rng)*7))]).join('');
    chartBox.setContent([
      `{cyan-fg}${selectedChartToken}{/cyan-fg}`,
      `{gray-fg}${spark}{/gray-fg}`,
      `{white-fg}5m: {green-fg}+${(Math.random()*15).toFixed(1)}%{/green-fg}`,
      `{white-fg}Vol: {cyan-fg}${(Math.random()*50).toFixed(1)}K{/cyan-fg}`,
      `{white-fg}Liq: {cyan-fg}${(Math.random()*200).toFixed(1)} SOL{/cyan-fg}`,
      `{gray-fg}tab to cycle token{/gray-fg}`,
    ].join('\n'));

    // Market scan (mock)
    const tokens = [
      {sym:'MONKE',liq:'42S',vol:'18K',mc:'92K',hold:184,risk:'MED',score:82},
      {sym:'DOGAI',liq:'22S',vol:'9K',mc:'44K',hold:77,risk:'HIGH',score:61},
      {sym:'WIF2',liq:'156S',vol:'45K',mc:'320K',hold:1204,risk:'LOW',score:91},
      {sym:'PEPEAI',liq:'9S',vol:'3K',mc:'18K',hold:52,risk:'HIGH',score:35},
      {sym:'BONK2',liq:'89S',vol:'24K',mc:'178K',hold:892,risk:'MED',score:78},
      {sym:'MYRO2',liq:'34S',vol:'11K',mc:'67K',hold:231,risk:'MED',score:68},
    ];
    const mhdr = '{gray-fg}'+pad('Sym',7)+' '+pad('Liq',8)+' '+pad('Vol',7)+' '+pad('MC',7)+' '+pad('Hold',5)+' '+pad('Risk',5)+' '+pad('Sc',4)+'{/gray-fg}';
    marketBox.setContent(mhdr+'\n'+tokens.map(t=>{
      const rC = t.risk==='LOW'?'green':t.risk==='MED'?'yellow':'red';
      return `{white-fg}${pad(t.sym,7)} ${pad(t.liq,8)} ${pad(t.vol,7)} ${pad(t.mc,7)} ${pad(String(t.hold),5)} {${rC}-fg}${pad(t.risk,5)}{/${rC}-fg} ${pad(String(t.score),4)}{/white-fg}`;
    }).join('\n'));

    // Risk alerts
    const alerts = [
      {sev:'HIGH',msg:'PEPEAI: mint authority enabled'},
      {sev:'HIGH',msg:'DOGAI: top10 holders 72.4%'},
      {sev:'WARN',msg:'birdeye: rate limited (429) fallback active'},
      {sev:'WARN',msg:'discord_signal_reader: OFFLINE'},
      {sev:'INFO',msg:`scan rate: ${s.scanRate}/s — healthy`},
    ];
    riskBox.setContent(alerts.map(a=>{
      const c = a.sev==='HIGH'?'red':a.sev==='WARN'?'yellow':'cyan';
      return `{${c}-fg}[${a.sev}]{/${c}-fg} {white-fg}${a.msg}{/white-fg}`;
    }).join('\n'));

    // Footer
    const fp = s.dailyPnl >= 0 ? '+' : '';
    footer.setContent(` {white-fg}SOL $${s.solPrice.toFixed(2)}  ·  RPC ${s.rpcStatus}  ·  DEX ${s.dexStatus}  ·  scan ${s.scanRate}/s  ·  pos ${s.openPositions}  ·  pnl ${fp}${s.dailyPnl.toFixed(2)} SOL  ·  [q] back  [space] pause  [h] help{/white-fg}`);

    screen.render();
  }

  // ── Keyboard ──
  let exiting = false;
  screen.key(['q'], () => {
    if (exiting) return;
    exiting = true;
    clearInterval(logTimer);
    clearInterval(renderTimer);
    [header,agentBox,toolsBox,posBox,logBox,chartBox,marketBox,riskBox,footer,helpBox].forEach(w => {
      screen.remove(w);
    });
    onBack();
  });

  screen.key(['space'], () => { paused = !paused; });
  screen.key(['1'], () => { logFilter = 'all'; });
  screen.key(['2'], () => { logFilter = 'SCAN'; });
  screen.key(['3'], () => { logFilter = 'TRADE'; });
  screen.key(['4'], () => { logFilter = 'RISK'; });
  screen.key(['5'], () => { logFilter = 'ERROR'; });
  screen.key(['tab'], () => { const toks = ['WIF2','MONKE','DOGAI','BONK2','POPCAT2']; const idx = toks.indexOf(selectedChartToken); selectedChartToken = toks[(idx+1)%toks.length]; });
  screen.key(['h'], () => {
    showHelp = !showHelp;
    if (showHelp) {
      helpBox.setContent(['{yellow-fg}Monitor Shortcuts{/yellow-fg}','','{white-fg}q{/white-fg} back to terminal','{white-fg}space{/white-fg} pause logs','{white-fg}1-5{/white-fg} filter logs','{white-fg}tab{/white-fg} cycle chart','{white-fg}h{/white-fg} toggle help','','{gray-fg}press h or esc to close{/gray-fg}'].join('\n'));
      helpBox.show();
    } else { helpBox.hide(); }
    screen.render();
  });
  screen.key(['escape'], () => { if (showHelp) { showHelp = false; helpBox.hide(); screen.render(); } });

  // ── Timers ──
  const logTimer = setInterval(() => { if (!paused) genLog(); }, 1500);
  const renderTimer = setInterval(() => { if (!paused) renderAll(); }, 1000);

  // Initial render
  renderAll();
  logBox.focus();

  return { logTimer, renderTimer };
}
