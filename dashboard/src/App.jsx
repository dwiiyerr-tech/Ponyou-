import { useState, useEffect, useRef, useMemo, startTransition } from "react";
import { LineChart, Line, XAxis, YAxis, ResponsiveContainer, BarChart, Bar, Cell, ReferenceLine, PieChart, Pie, RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis, Radar } from "recharts";

/* ─── CSS ──────────────────────────────────────────────────── */
const GCSS = `
  @import url('https://fonts.googleapis.com/css2?family=VT323&family=IBM+Plex+Mono:wght@400;500&display=swap');
  @keyframes orbGlow  { 0%,100%{filter:drop-shadow(0 0 6px rgba(217,119,87,.5))} 50%{filter:drop-shadow(0 0 14px rgba(217,119,87,.8))} }
  @keyframes blink    { 0%,100%{opacity:1} 50%{opacity:.18} }
  @keyframes fadeIn   { from{opacity:0;transform:translateY(-5px)} to{opacity:1;transform:none} }
  @keyframes scanning { 0%{width:0} 100%{width:100%} }
  @keyframes ticker   { 0%{transform:translateX(0)} 100%{transform:translateX(-50%)} }
  @keyframes pulse    { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:.6;transform:scale(.94)} }
  * { box-sizing:border-box; margin:0; padding:0; }
  ::-webkit-scrollbar { width:4px; }
  ::-webkit-scrollbar-thumb { background:#20202A; border-radius:2px; }
  .agent-scroll::-webkit-scrollbar { height: 6px; }
  .agent-scroll::-webkit-scrollbar-thumb { background: #303040; border-radius: 3px; }
  .agent-scroll::-webkit-scrollbar-track { background: #0A0A10; }
`;

/* ─── Palette: Galaxy Dark ─────────────────────────────────── */
const C = {
  bg:      "#050508", // Very deep space black
  panel:   "#0A0A10", // Slightly lighter for panels
  card:    "#101016", // Even lighter for inner cards
  border:  "#20202A", // Dark border
  sh:      "rgba(0,0,0,0.5)",
  sh2:     "rgba(0,0,0,0.3)",

  orange:  "#E88D6A", // Vibrant neon orange
  orangeL: "#F0B9A5",
  orangeD: "#C45B3A",
  orangeG: "rgba(232,141,106,.15)",
  orangeGX:"rgba(232,141,106,.08)",

  purple:  "#9B7EC8", // Bright purple
  purpleL: "#B8A3D8",
  purpleG: "rgba(155,126,200,.15)",

  amber:   "#D4A35B", // Neon amber
  amberL:  "#E8C895",
  amberG:  "rgba(212,163,91,.15)",

  green:   "#6BA879", // Vibrant green
  greenG:  "rgba(107,168,121,.15)",
  red:     "#E54D5A", // Neon red
  redG:    "rgba(229,77,90,.15)",

  ink:     "#F0F0F5", // Off-white for high contrast text
  ink2:    "#D0D0D8", // Slightly dimmed
  dim:     "#808090", // Gray text
  dim2:    "#606070", // Darker gray

  bear:    "#E54D5A",
  bull:    "#6BA879",
  median:  "#9B7EC8",
  catalyst:"#E88D6A",
  cluster: "#D4A35B",
};

const PX = "'VT323', monospace";
const MN = "'IBM Plex Mono','Courier New', monospace";

/* ─── UI Atoms ─────────────────────────────────────────────── */
const Lbl = ({children,col=C.dim2,sz=9})=>(
  <span style={{color:col,fontSize:sz,fontFamily:MN,letterSpacing:.4}}>{children}</span>
);
const Bdg = ({children,col=C.orange,bg,filled})=>(
  <span style={{
    border:`1px solid ${col}`, color: filled?C.panel:col,
    background: filled?col:(bg||col+"12"),
    fontSize:9,fontFamily:MN,padding:"1px 7px",
    display:"inline-block",letterSpacing:1,
  }}>{children}</span>
);
const Row = ({children,style})=>(
  <div style={{display:"flex",alignItems:"center",...style}}>{children}</div>
);
const PixNum = ({val,prefix="$",size=60,col=C.orange})=>(
  <span style={{fontFamily:PX,fontSize:size,color:col,lineHeight:1,
    textShadow:`1px 1px 0 ${col}22`}}>
    {prefix}{typeof val==="number"?val.toLocaleString("en-US"):val}
  </span>
);

const LiveClock = () => {
  const [value, setValue] = useState(() => new Date().toTimeString().slice(0,8));
  useEffect(() => {
    const timer = setInterval(() => setValue(new Date().toTimeString().slice(0,8)), 1000);
    return () => clearInterval(timer);
  }, []);
  return <>{value}</>;
};
const LiveDot = ({col=C.green}) => (
  <span style={{color:col,display:"inline-block",animation:"blink 1.2s ease-in-out infinite"}}>●</span>
);

/* ─── Claude Orb ───────────────────────────────────────────── */
const ClaudeOrb = ({size=58})=>(
  <div style={{width:size,height:size,flexShrink:0,animation:"orbGlow 2.6s ease-in-out infinite"}}>
    <svg width={size} height={size} viewBox="0 0 58 58">
      <defs>
        <radialGradient id="lg1" cx="38%" cy="32%" r="65%">
          <stop offset="0%" stopColor="#F2B088"/>
          <stop offset="50%" stopColor={C.orange}/>
          <stop offset="100%" stopColor={C.purple}/>
        </radialGradient>
        <radialGradient id="lg2" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#2A2A35"/>
          <stop offset="100%" stopColor="#101016"/>
        </radialGradient>
      </defs>
      <circle cx="29" cy="29" r="27.5" fill="none" stroke={C.orange} strokeWidth=".6" opacity=".4"/>
      <circle cx="29" cy="29" r="25" fill="url(#lg1)" opacity=".92"/>
      <circle cx="29" cy="29" r="17" fill="url(#lg2)"/>
      <path d="M 29 12 A 17 17 0 0 1 46 29" stroke="white" strokeWidth="2.8" fill="none" strokeLinecap="round" opacity=".9"/>
      <path d="M 29 46 A 17 17 0 0 1 12 29" stroke="white" strokeWidth="2.8" fill="none" strokeLinecap="round" opacity=".9"/>
      <path d="M 20 15 A 14 14 0 0 1 43 20" stroke="white" strokeWidth="1.3" fill="none" strokeLinecap="round" opacity=".45"/>
      <path d="M 38 43 A 14 14 0 0 1 15 38" stroke="white" strokeWidth="1.3" fill="none" strokeLinecap="round" opacity=".45"/>
      <circle cx="29" cy="29" r="2.8" fill="#F2B088" opacity=".95"/>
      <circle cx="22" cy="20" r="1.1" fill="white" opacity=".6"/>
    </svg>
  </div>
);

/* ─── Segmented bar ────────────────────────────────────────── */
const SegBar = ({pct=.78,segs=48})=>(
  <div style={{display:"flex",gap:1.5,height:5,margin:"7px 0 3px"}}>
    {Array.from({length:segs},(_,i)=>{
      const p=i/segs,on=p<pct;
      const col=p<pct*.6?C.green:p<pct*.9?C.amber:C.red;
      return <div key={i} style={{flex:1,height:"100%",
        background:on?col:C.border,borderRadius:1}}/>;
    })}
  </div>
);

/* ─── Panel wrapper ────────────────────────────────────────── */
const Panel = ({children,style,accent,shadow=true})=>(
  <div style={{
    border:`1px solid ${C.border}`,
    background:C.panel,
    position:"relative",overflow:"hidden",
    boxShadow:shadow?`0 1px 4px ${C.sh},0 0 0 0.5px ${C.border}`:"none",
    ...style,
  }}>
    {accent&&<div style={{position:"absolute",top:0,left:0,right:0,height:2,
      background:`linear-gradient(to right,${C.orange},${C.purple})`}}/>}
    {children}
  </div>
);

/* ─── Global Data Stream Terminal ──────────────────────────── */
function GlobalDataStream({msgs}) {
  return (
    <div style={{display:"flex",flexDirection:"column",height:"100%"}}>
      <div style={{
        padding:"10px 16px",background:"#08080C",
        borderBottom:`1px solid ${C.border}`,
        display:"flex",justifyContent:"space-between",alignItems:"center"
      }}>
        <span style={{color:C.purpleL,fontSize:12,fontFamily:MN,fontWeight:"bold",letterSpacing:2}}>
          &gt;_ GLOBAL AGENT DATA STREAM
        </span>
        <Row style={{gap: 12}}>
          <span style={{color:C.dim2,fontSize:10,fontFamily:MN}}>AUTO-SCROLL: ON</span>
          <Row style={{gap: 4}}>
            <div style={{width:8,height:8,borderRadius:"50%",background:C.green, boxShadow:`0 0 8px ${C.green}`}}/>
            <span style={{color:C.green,fontSize:10,fontFamily:MN}}>LIVE</span>
          </Row>
        </Row>
      </div>
      <div style={{flex:1,overflowY:"auto",padding:"12px 16px", background:"#030305", display:"flex", flexDirection:"column-reverse"}}>
        {msgs.map((m,i)=>(
          <div key={m.id||i} style={{
            padding:"6px 0", borderBottom:`1px dashed #1A1A24`,
            animation: i===0?"fadeIn .3s ease":"none",
            display:"flex",gap:12,alignItems:"flex-start",
          }}>
            <span style={{color:"#4A4A5A",fontSize:11,fontFamily:MN,marginTop:2,flexShrink:0}}>
              [{m.time}]
            </span>
            <span style={{
              color:C.orange,fontSize:11,fontFamily:MN,letterSpacing:.5,fontWeight:"bold",
              background:C.orange+"15",padding:"2px 6px",borderRadius:2,flexShrink:0,
              minWidth: 90, textAlign:"center"
            }}>{m.type}</span>
            <span style={{color:C.ink,fontSize:12,fontFamily:MN,lineHeight:1.5}}>
              {m.text}
            </span>
            {i===0 && (
              <span style={{width:6,height:14,background:C.green,marginTop:2,animation:"pulse 1s infinite"}}/>
            )}
          </div>
        ))}
        {msgs.length === 0 && (
          <div style={{color:C.dim,fontSize:12,fontFamily:MN,padding:"20px",textAlign:"center",letterSpacing:1}}>
            &gt; WAITING FOR ENCRYPTED DATA STREAM...
          </div>
        )}
      </div>
    </div>
  );
}

/* ─── Live ticker ──────────────────────────────────────────── */
function AgentTicker({msgs}) {
  const text = msgs.slice(0,6).map(m=>`[${m.type}] ${m.text}`).join("   ·   ");
  return (
    <div style={{
      background:C.orange,color:C.panel,
      fontSize:9,fontFamily:MN,letterSpacing:.6,
      padding:"3px 0",overflow:"hidden",position:"relative",
    }}>
      <div style={{
        display:"inline-block",whiteSpace:"nowrap",
        animation:"ticker 28s linear infinite",
        paddingLeft:"100%",
      }}>
        {text ? (text + "   ·   " + text) : "AWAITING LIVE DATA STREAM..."}
      </div>
    </div>
  );
}

/* ─── Global Agent Roster ──────────────────────────────────── */
const AGENT_NAMES = [
  "PONYOU CORE", "TOKEN COOKER", "MARKET RADAR", "PORTFOLIO ANALYZER",
  "SWAP EXECUTION", "SCREENING GUARD", "SMART MONEY TRACKER",
  "SOCIAL HUNTER", "RUG MONITOR", "STRATEGY ENGINE", 
  "CAST-NET", "DOCTOR", "EVOLUTION ENGINE", 
  "EXECUTION WALLET", "RISK MANAGER", "LIQUIDITY SNIPER", 
  "ON-CHAIN SPY", "ORACLE NODE"
];

/* ─── Network Canvas ───────────────────────────────────────── */
function NetGraph({mobile, msgs, secondBrain}) {
  const ref = useRef(null);
  const sim = useRef({nodes:[],edges:[],raf:null,tick:0});
  const msgsRef = useRef(msgs || []);
  msgsRef.current = msgs || [];
  
  // Make the graph significantly taller (Grander scale)
  const H = mobile ? 280 : 380;

  useEffect(()=>{
    const cv=ref.current; if(!cv) return;
    const W=cv.offsetWidth||600;
    cv.width=W; cv.height=H;

    // Build glow bitmaps once. Recreating radial gradients for every node on
    // every frame caused visible frame-time spikes after the cores grew.
    const makeGlowSprite = (radius, color) => {
      const size = Math.max(2, Math.ceil(radius * 2));
      const sprite = document.createElement("canvas");
      sprite.width = size;
      sprite.height = size;
      const spriteCtx = sprite.getContext("2d");
      const center = size / 2;
      const gradient = spriteCtx.createRadialGradient(center, center, 0, center, center, center);
      gradient.addColorStop(0, color);
      gradient.addColorStop(1, "transparent");
      spriteCtx.fillStyle = gradient;
      spriteCtx.fillRect(0, 0, size, size);
      return sprite;
    };
    
    const N = AGENT_NAMES.length;

    const nodes = AGENT_NAMES.map((name, id) => {
      if (id === 0) {
        return { 
          id, label: name, 
          r: 11, // Keep the primary core visually dominant
          orbitRadiusX: 0, orbitRadiusY: 0, orbitSpeed: 0, phase: 0, rotSpeed: 1
        };
      }
      
      // Distribute orbits outward
      const t = id / (N - 1); 
      // X radius uses full width, Y radius constrained by height
      const orbitRadiusX = 35 + t * (W/2 - 50) * (mobile ? 0.9 : 1.0);
      const orbitRadiusY = 25 + t * (H/2 - 30) * (mobile ? 0.8 : 1.0);
      
      // Inner planets move faster, outer move slower. Randomize direction.
      const dir = Math.random() > 0.5 ? 1 : -1;
      const orbitSpeed = (0.2 + (1 - t) * 0.3) * dir; 

      return {
        id, label: name,
        r: 3.2 + Math.random() * 2.4, // Slightly larger sub-agent cores
        orbitRadiusX,
        orbitRadiusY,
        orbitSpeed,
        phase: Math.random() * Math.PI * 2, // Random starting position on orbit
        rotSpeed: 0.5 + Math.random() * 1.5 // Speed of their visual orbiting ring
      };
    });

    nodes.forEach((node) => {
      const isSun = node.id === 0;
      node.glowRadius = node.r * (isSun ? 5 : 4);
      node.glowSprite = makeGlowSprite(
        node.glowRadius,
        isSun ? "rgba(217, 119, 87, 1)" : "rgba(255, 255, 255, 1)"
      );
    });
    
    // Edges (Bloodstream)
    const edges = [];
    // 1. Every agent connects to the Core (Sun) so they don't look like floating debris
    for (let i = 1; i < N; i++) {
      edges.push({ a: 0, b: i });
    }
    
    // 2. Real Architectural Workflow (Cross-agent communication)
    edges.push(
      // Data Gathering -> MARKET RADAR (2)
      {a: 16, b: 2}, {a: 7, b: 2}, {a: 6, b: 2}, {a: 10, b: 2},
      // MARKET RADAR -> SCREENING GUARD (5)
      {a: 2, b: 5},
      // Security tools -> SCREENING GUARD (5)
      {a: 8, b: 5}, {a: 17, b: 5},
      // SCREENING GUARD -> PORTFOLIO ANALYZER (3)
      {a: 5, b: 3},
      // Strategy/Risk -> PORTFOLIO ANALYZER (3)
      {a: 14, b: 3}, {a: 9, b: 3},
      // PORTFOLIO ANALYZER -> EXECUTION WALLET (13)
      {a: 3, b: 13},
      // Execution helpers -> EXECUTION WALLET (13)
      {a: 4, b: 13}, {a: 15, b: 13}, {a: 1, b: 13}
    );
    
    // Background dust (distant static stars)
    const dust = Array.from({length:120}, ()=>({
      x: Math.random()*W, y: Math.random()*H, 
      r: Math.random()*1.5, phase: Math.random()*Math.PI*2,
      blinkSpeed: 0.1 + Math.random()*0.4
    }));

    // Each anonymous star represents one Markdown note in the Second Brain.
    // Content density controls size, freshness controls glow, and note metadata
    // determines a stable orbit without exposing file names or note text.
    const brainStars = (secondBrain?.stars || []).map((star) => {
      const orbit = Math.max(0, Math.min(1, star.orbit || 0));
      return {
        ...star,
        phase: (star.phase || 0) * Math.PI * 2,
        radiusX: 18 + orbit * Math.max(12, W / 2 - 42),
        radiusY: 14 + orbit * Math.max(10, H / 2 - 34),
        r: 0.55 + Math.max(0, Math.min(1, star.weight || 0)) * 1.15,
      };
    });

    sim.current={nodes,edges,dust,brainStars,raf:null,tick:0};

    const draw=()=>{
      const time = performance.now() * 0.001; 
      const ns=sim.current.nodes, ds=sim.current.dust, bs=sim.current.brainStars;
      const ctx=cv.getContext("2d", { alpha: false }); 
      
      // Dark space background
      ctx.fillStyle="#08080A"; 
      ctx.fillRect(0,0,W,H);

      const cx = W / 2;
      const cy = H / 2;

      // Draw distant stars (dust) - Twinkling
      ctx.fillStyle = "#ffffff";
      ds.forEach(d => {
        ctx.globalAlpha = 0.1 + Math.sin(time * d.blinkSpeed + d.phase) * 0.15;
        ctx.beginPath(); ctx.arc(d.x, d.y, d.r, 0, Math.PI*2); ctx.fill();
      });
      ctx.globalAlpha = 1;

      // Second Brain notes orbit quietly behind the agent relationship graph.
      const brainColors = [C.purpleL, C.orangeL, C.amberL, C.green];
      bs.forEach((star) => {
        const angle = time * star.speed + star.phase;
        const x = cx + Math.cos(angle) * star.radiusX;
        const y = cy + Math.sin(angle) * star.radiusY;
        const twinkle = 0.72 + Math.sin(time * (0.8 + star.pulse) + star.phase) * 0.28;
        const alpha = (0.24 + star.freshness * 0.5) * twinkle;
        const color = brainColors[star.color_index] || C.purpleL;

        ctx.globalAlpha = alpha * 0.24;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(x, y, star.r * 3.2, 0, Math.PI * 2);
        ctx.fill();

        ctx.globalAlpha = alpha;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(x, y, star.r, 0, Math.PI * 2);
        ctx.fill();
      });
      ctx.globalAlpha = 1;

      // Calculate positions & Draw Orbit paths
      ns.forEach(n => {
        if (n.id === 0) {
          n.x = cx; n.y = cy;
        } else {
          // Orbiting math
          const angle = time * n.orbitSpeed * 0.5 + n.phase; // slowed down orbit speed slightly
          n.x = cx + Math.cos(angle) * n.orbitRadiusX;
          n.y = cy + Math.sin(angle) * n.orbitRadiusY;

          // Draw the faint elliptical orbit line
          ctx.beginPath();
          ctx.ellipse(cx, cy, n.orbitRadiusX, n.orbitRadiusY, 0, 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(255, 255, 255, 0.04)`;
          ctx.lineWidth = 1;
          ctx.stroke();
        }
      });

      // Evaluate real-time activity for all nodes
      const nowTs = Date.now();
      ns.forEach(n => {
        const isSun = n.id === 0;
        const latestMsg = msgsRef.current.find(m => {
          const prefixStr = n.label.split(" ")[0].replace("-", ""); // ON-CHAIN -> ONCHAIN
          const rawMatch = m.rawType ? m.rawType.replace("_", "") : ""; // CAST_NET -> CASTNET
          return m.type.includes(prefixStr) || rawMatch.includes(prefixStr);
        });
        const isRecent = latestMsg && (nowTs - latestMsg.ts < 60000); // Stay active for 60 seconds!
        const txt = isSun ? "SYNC: 99.8% STABLE" : (latestMsg ? latestMsg.text.replace(`[${n.label}] `, "") : "STANDBY");
        n.isActive = isSun ? true : (isRecent && txt !== "STANDBY" && txt.length > 5);
        n.txt = txt;
      });

      // Draw edges (Bloodstream)
      edges.forEach(e=>{
        const a=ns[e.a],b=ns[e.b];
        // Edge is active if ANY of its connected planets is active
        const edgeActive = (e.a !== 0 && a.isActive) || (e.b !== 0 && b.isActive);
        
        // Smooth pulse logic based on time
        const pulse = edgeActive ? (Math.sin(time * 0.6 - (e.a+e.b)) * 0.5 + 0.5) : 0;
        
        ctx.beginPath(); ctx.moveTo(a.x,a.y); ctx.lineTo(b.x,b.y);
        ctx.strokeStyle = edgeActive ? `rgba(255, 50, 50, ${0.4 + pulse*0.5})` : `rgba(255, 255, 255, 0.15)`; // Brighter inactive state
        ctx.lineWidth = edgeActive ? (1 + pulse * 1.5) : 1;
        ctx.stroke();
        
        // Moving "blood cell"
        if (edgeActive) {
          const t = (time * 0.2 + (e.a * 0.1)) % 1; 
          const cellX = a.x + (b.x - a.x) * t;
          const cellY = a.y + (b.y - a.y) * t;
          ctx.beginPath(); ctx.arc(cellX, cellY, 1.5, 0, Math.PI*2);
          ctx.fillStyle = `rgba(255, 70, 70, ${Math.sin(t * Math.PI)})`; 
          ctx.fill();
        }
      });

      // Draw nodes (Sun & Planets)
      ns.forEach(n=>{
        const isSun = n.id === 0;
        const pulse = Math.sin(time * 0.8 + n.phase) * 0.5 + 0.5; 
        
        // Core star
        ctx.beginPath(); ctx.arc(n.x, n.y, n.r, 0, Math.PI*2);
        ctx.fillStyle = isSun ? "#F2B088" : "#ffffff";
        ctx.fill();
        
        // Smooth Glow (cached bitmap keeps large cores inexpensive per frame)
        const baseGlow = isSun ? 0.5 : (n.isActive ? 0.4 : 0.2);
        ctx.globalAlpha = baseGlow + pulse * 0.3;
        ctx.drawImage(
          n.glowSprite,
          n.x - n.glowRadius,
          n.y - n.glowRadius,
          n.glowRadius * 2,
          n.glowRadius * 2
        );
        ctx.globalAlpha = 1;
        
        // Visual Rotation (Orbiting ring)
        const rotAngle = time * n.rotSpeed + n.phase;
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r + (isSun ? 6 : 3), rotAngle, rotAngle + Math.PI * 1.5);
        ctx.strokeStyle = isSun ? `rgba(217, 119, 87, ${0.6 + pulse*0.4})` : (n.isActive ? `rgba(255, 255, 255, ${0.3 + pulse*0.3})` : `rgba(255, 255, 255, 0.1)`);
        ctx.lineWidth = 1;
        ctx.stroke();

        ctx.textAlign = "left";
        // Label
        ctx.fillStyle = `rgba(255, 255, 255, ${n.isActive ? 0.9 : 0.4})`;
        ctx.font = `bold 8px ${MN}`;
        ctx.fillText(n.label, n.x + n.r + 6, n.y - 1);
        
        // Task Text
        ctx.fillStyle = isSun ? C.green : (n.isActive ? C.orange : `rgba(255, 255, 255, 0.3)`);
        ctx.font = `7.5px ${MN}`;
        const shortTxt = n.txt.length > 28 ? n.txt.slice(0, 28) + "..." : n.txt;
        ctx.fillText(shortTxt, n.x + n.r + 6, n.y + 7);

        // Inner orbital dot
        if (n.isActive) {
          const dotDist = n.r + (isSun ? 6 : 3);
          const dotX = n.x + Math.cos(rotAngle + Math.PI * 1.5) * dotDist;
          const dotY = n.y + Math.sin(rotAngle + Math.PI * 1.5) * dotDist;
          ctx.beginPath(); ctx.arc(dotX, dotY, isSun ? 1.5 : 1, 0, Math.PI*2);
          ctx.fillStyle = isSun ? "#ffffff" : "#D97757"; 
          ctx.fill();
        }
      });


      sim.current.raf=requestAnimationFrame(draw);
    };
    sim.current.raf=requestAnimationFrame(draw);
    return()=>cancelAnimationFrame(sim.current.raf);
  },[mobile,H,secondBrain?.signature]);

  return <canvas ref={ref} style={{display:"block",width:"100%",height:H, borderRadius: 4}}/>;
}

/* ─── MAIN ─────────────────────────────────────────────────── */
export default function PonyouDashboard() {
  const [mobile,setMobile] = useState(window.innerWidth<768);
  const [agentMsgs,setAgentMsgs] = useState([]);
  
  // Real-time Data States
  const [botState, setBotState] = useState(null);
  const [castNetData, setCastNetData] = useState(null);
  const [panopticonData, setPanopticonData] = useState(null);
  
  // Computed Stats
  const totalBalance = botState?.balance_sol ? botState.balance_sol : 0.000;
  const inc = botState?.pnl_today_usd ? botState.pnl_today_usd : 0.00;
  const winRate = botState?.win_rate ? (botState.win_rate*100).toFixed(1) : "0.0";
  const tradesCount = botState?.positions ? botState.positions.length : 0;
  const pnlData = useMemo(() => Array.from({length:30}, (_,i)=>({
    i, v: inc * (i/30) + (Math.random()*10-5)
  })), [inc]);
  const winBars = useMemo(() => Array.from({length:30}, ()=>({
    v: Math.random()*20 - 5
  })), []);

  useEffect(()=>{
    const check=()=>setMobile(window.innerWidth<768);
    window.addEventListener("resize",check);
    return()=>window.removeEventListener("resize",check);
  },[]);

  // WebSocket Connection
  useEffect(()=>{
    let ws;
    let reconnectTimer;
    const connect = () => {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${window.location.host}/ws`;
      ws = new WebSocket(wsUrl);

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === "state") startTransition(() => setBotState(msg.data));
          else if (msg.type === "log") {
            startTransition(() => setAgentMsgs(p => {
              const text = msg.data;
              // Logs: [2026-06-08T06:19:42.928Z] [TRASH_FILTER] BLOCKED...
              const match = text.match(/^\[.*?\]\s*\[(.*?)\]\s*(.*)/);
              let rawType = "SYS";
              let cleanText = text;
              if (match) {
                rawType = match[1].toUpperCase();
                cleanText = match[2];
              }

              let type = rawType;
              // Map raw log prefixes to the 3 main broad column groups in the UI
              if (["ONCHAIN", "ONCHAIN_LISTENER", "HUNTER", "MARKET", "SOCIAL_HUNTER", "SOCIAL_GATE_SUMMARY", "CAST_NET", "SMART_MONEY"].includes(rawType)) type = "MARKET";
              if (["TRASH_FILTER", "TRASH_LAYER", "SCREENING", "LEARNING", "RUG", "RUG_MONITOR", "ORACLE"].includes(rawType)) type = "SCREENING";
              if (["CRON", "PORTFOLIO", "MANAGER", "RISK", "STRATEGY", "EXECUTION", "TRADE", "SWAP", "LIQUIDITY"].includes(rawType)) type = "PORTFOLIO";

              const time = new Date().toTimeString().slice(0,8);
              const nm = [{ id: Date.now()+Math.random(), time, type, rawType, text: cleanText, ts: Date.now() }, ...p];
              // Keep up to 200 logs so one spammy agent doesn't push out all other agents' logs
              if (nm.length > 200) nm.pop();
              return nm;
            }));
          }
        } catch(e) {}
      };

      ws.onclose = () => { reconnectTimer = setTimeout(connect, 3000); };
    };
    connect();

    const pollData = async () => {
      try {
        const [cnRes, panRes] = await Promise.all([
          fetch('/api/castnet').catch(()=>null),
          fetch('/api/panopticon').catch(()=>null)
        ]);
        if(cnRes && cnRes.ok) { const data = await cnRes.json(); startTransition(() => setCastNetData(data)); }
        if(panRes && panRes.ok) { const data = await panRes.json(); startTransition(() => setPanopticonData(data)); }
      } catch(e) {}
    };
    pollData();
    const iv = setInterval(pollData, 5000);
    
    return ()=> { clearTimeout(reconnectTimer); clearInterval(iv); if(ws) ws.close(); };
  },[]);

  // Simulated System Heartbeat (keeps UI active when real logs are quiet)
  useEffect(() => {
    const iv = setInterval(() => {
      const texts = [
        "[ORACLE] Synchronized with Solana mainnet (14ms ping)",
        "[DOCTOR] Health check passed. Memory stable.",
        "[PONYOU] Listening for incoming signals..."
      ];
      const text = texts[Math.floor(Math.random() * texts.length)];
      setAgentMsgs(p => {
        // Only insert heartbeat if there hasn't been a real message very recently
        if (p.length > 0 && (Date.now() - p[0].id) < 2000) return p;
        const time = new Date().toTimeString().slice(0,8);
        const typeMatch = text.match(/\[([A-Z]+)\]/);
        const type = typeMatch ? typeMatch[1] : "SYS";
        const nm = [{ id: Date.now(), time, type, text }, ...p];
        if (nm.length > 50) nm.pop();
        return nm;
      });
    }, 4500);
    return () => clearInterval(iv);
  }, []);

  const fmt=n=>Number(n).toLocaleString("en-US");
  const str=totalBalance.toFixed(3), grpA=str.split('.')[0], grpB=str.split('.')[1];

  /* ── Brain Monitor Section ── */
  const BrainMonitorSection = () => {
    // Real-time metrics from backend botState
    const coreLoad = botState?.brain_metrics?.coreLoad || 0;
    const secondLoad = botState?.brain_metrics?.secondLoad || 0;
    
    const loadColor = coreLoad > 80 ? C.red : (coreLoad > 60 ? C.orange : C.green);

    const Equalizer = ({ load, color }) => (
      <div style={{display:"flex", gap:3, height: 28, alignItems:"flex-end", paddingBottom: 4}}>
        {Array.from({length: 16}).map((_, i) => {
          const isActive = (i / 16) < (load / 100);
          const h = isActive ? (20 + Math.random() * 80) : (5 + Math.random() * 15);
          return <div key={i} style={{flex:1, height: `${h}%`, background: isActive ? color : C.border, transition: "height 0.2s ease"}}/>
        })}
      </div>
    );

    return (
      <div style={{display:"grid", gridTemplateColumns: mobile ? "1fr" : "1fr 1fr", gap: 14, marginTop: 8}}>
        {/* Primary Core */}
        <Panel style={{padding: "12px 16px", background: C.card, border: `1px solid ${C.orange}44`}} shadow={false}>
          <div style={{display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom: 12, borderBottom:`1px dashed ${C.border}`, paddingBottom:8}}>
            <Row style={{gap: 8}}>
              <div style={{width:8, height:8, borderRadius:"50%", background:C.orange, boxShadow:`0 0 10px ${C.orange}`}}/>
              <span style={{color:C.orange, fontSize:12, fontWeight:"bold", fontFamily:MN, letterSpacing:1}}>PRIMARY BRAIN CORE</span>
            </Row>
            <Bdg col={C.orange}>PONYOU ORCHESTRA</Bdg>
          </div>
          <div style={{display:"grid", gridTemplateColumns:"1fr 120px", gap: 16}}>
            <div>
              <Row style={{justifyContent:"space-between", marginBottom:6}}>
                <span style={{color:C.dim2, fontSize:9, fontFamily:MN}}>ORCHESTRATION LOAD</span>
                <span style={{color:C.ink, fontSize:10, fontFamily:MN, fontWeight:"bold"}}>{coreLoad.toFixed(1)}%</span>
              </Row>
              <Equalizer load={coreLoad} color={C.orange} />
              <Row style={{justifyContent:"space-between", marginTop: 4}}>
                <span style={{color:C.dim2, fontSize:9, fontFamily:MN}}>ROUTING LATENCY</span>
                <span style={{color:C.ink, fontSize:10, fontFamily:MN, fontWeight:"bold"}}>{(12 + Math.random()*10).toFixed(0)}ms</span>
              </Row>
            </div>
            <div style={{display:"flex", flexDirection:"column", gap: 6, justifyContent:"center", paddingLeft: 16, borderLeft: `1px solid ${C.border}`}}>
              <div>
                <div style={{color:C.dim2, fontSize:9, fontFamily:MN}}>ACTIVE AGENTS</div>
                <div style={{color:C.ink, fontSize:11, fontFamily:MN, fontWeight:"bold"}}>18 / 18</div>
              </div>
              <div>
                <div style={{color:C.dim2, fontSize:9, fontFamily:MN}}>SYSTEM STATUS</div>
                <div style={{color:C.ink, fontSize:11, fontFamily:MN, fontWeight:"bold"}}>SYNCHRONIZED</div>
              </div>
            </div>
          </div>
        </Panel>

        {/* Second Brain */}
        <Panel style={{padding: "12px 16px", background: C.card, border: `1px solid ${C.purple}44`}} shadow={false}>
          <div style={{display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom: 12, borderBottom:`1px dashed ${C.border}`, paddingBottom:8}}>
            <Row style={{gap: 8}}>
              <div style={{width:8, height:8, borderRadius:"50%", background:C.purple, boxShadow:`0 0 10px ${C.purple}`}}/>
              <span style={{color:C.purpleL, fontSize:12, fontWeight:"bold", fontFamily:MN, letterSpacing:1}}>SECOND BRAIN</span>
            </Row>
            <Bdg col={C.purple}>EXPERIENCE DATA (.MD)</Bdg>
          </div>
          <div style={{display:"grid", gridTemplateColumns:"1fr 120px", gap: 16}}>
            <div>
              <Row style={{justifyContent:"space-between", marginBottom:6}}>
                <span style={{color:C.dim2, fontSize:9, fontFamily:MN}}>I/O READ/WRITE</span>
                <span style={{color:C.ink, fontSize:10, fontFamily:MN, fontWeight:"bold"}}>{secondLoad.toFixed(1)}%</span>
              </Row>
              <Equalizer load={secondLoad} color={C.purple} />
              <Row style={{justifyContent:"space-between", marginTop: 4}}>
                <span style={{color:C.dim2, fontSize:9, fontFamily:MN}}>RETRIEVAL SPEED</span>
                <span style={{color:C.ink, fontSize:10, fontFamily:MN, fontWeight:"bold"}}>{(2 + Math.random()*2).toFixed(1)}ms</span>
              </Row>
            </div>
            <div style={{display:"flex", flexDirection:"column", gap: 6, justifyContent:"center", paddingLeft: 16, borderLeft: `1px solid ${C.border}`}}>
              <div>
                <div style={{color:C.dim2, fontSize:9, fontFamily:MN}}>INDEXED FILES</div>
                <div style={{color:C.ink, fontSize:11, fontFamily:MN, fontWeight:"bold"}}>1,284 .MD</div>
              </div>
              <div>
                <div style={{color:C.dim2, fontSize:9, fontFamily:MN}}>MEMORY TYPE</div>
                <div style={{color:C.ink, fontSize:11, fontFamily:MN, fontWeight:"bold"}}>LONG-TERM VAULT</div>
              </div>
            </div>
          </div>
        </Panel>
      </div>
    );
  };

  /* ── Skill Radar Section ── */
  const SkillRadarSection = () => {
    const sm = botState?.skill_metrics || { cooking:0, swap:0, track:0, token:0, market:0, portfolio:0 };
    const data = [
      { subject: 'COOKING', A: sm.cooking, fullMark: 100 },
      { subject: 'SWAP', A: sm.swap, fullMark: 100 },
      { subject: 'TRACK', A: sm.track, fullMark: 100 },
      { subject: 'TOKEN', A: sm.token, fullMark: 100 },
      { subject: 'MARKET', A: sm.market, fullMark: 100 },
      { subject: 'PORTFOLIO', A: sm.portfolio, fullMark: 100 },
    ];
    
    return (
      <div style={{display:"grid", gridTemplateColumns: mobile ? "1fr" : "280px 1fr", gap: 8, marginTop: 8}}>
        <Panel style={{background:C.card, padding: 0, height: 210, position:"relative", overflow:"hidden"}} shadow={false}>
          <div style={{position:"absolute", top: 12, left: 16, color:C.purpleL, fontSize:12, fontWeight:"bold", fontFamily:MN, letterSpacing:1.5}}>
            HOLOGRAPHIC SKILL RADAR
          </div>
          <ResponsiveContainer width="100%" height="100%">
            <RadarChart cx="50%" cy="55%" outerRadius="65%" data={data}>
              <PolarGrid stroke={C.border} />
              <PolarAngleAxis dataKey="subject" tick={{ fill: C.dim2, fontSize: 9, fontFamily: MN }} />
              <PolarRadiusAxis angle={30} domain={[0, 100]} tick={false} axisLine={false} />
              <Radar name="Ponyou" dataKey="A" stroke={C.orange} fill={C.orange} fillOpacity={0.3} isAnimationActive={false} />
            </RadarChart>
          </ResponsiveContainer>
        </Panel>
        
        <Panel style={{background:C.card, padding: "12px 16px", height: 210, overflow:"hidden"}} shadow={false}>
          <div style={{color:C.purpleL, fontSize:12, fontWeight:"bold", fontFamily:MN, letterSpacing:1.5, marginBottom:10, borderBottom:`1px dashed ${C.border}`, paddingBottom:6}}>
            CORE SKILL TELEMETRY LOG
          </div>
          <div style={{display:"flex", flexDirection:"column", gap: 8}}>
            {[
              {s: "COOKING", text: "Awaiting market conditions. 0 tokens launched.", c: C.dim},
              {s: "SWAP", text: "Executed Buy $BONK at 0.002 SOL (Success)", c: C.green},
              {s: "TRACK", text: "Tracking 24 Smart Money Wallets...", c: C.amber},
              {s: "TOKEN", text: "Blocked 14 Honeypot contracts in last hour.", c: C.red},
              {s: "MARKET", text: "Scanning 245 new tokens on Raydium...", c: C.orange},
              {s: "PORTFOLIO", text: "Portfolio balanced. PnL +$214.50", c: C.green}
            ].map((d, i) => (
              <div key={i} style={{display:"flex", gap: 10, alignItems:"center", paddingBottom: 6, borderBottom: i===5 ? "none" : `1px solid ${C.border}`}}>
                <span style={{color:d.c, fontSize:10, fontFamily:MN, fontWeight:"bold", width: 65}}>[{d.s}]</span>
                <span style={{color:C.ink, fontSize:10, fontFamily:MN}}>{d.text}</span>
              </div>
            ))}
          </div>
        </Panel>
      </div>
    );
  };

  /* ── Agent Fleet Grid ── */
  const AgentFleetGrid = () => (
    <Panel style={{marginTop: 8, padding: "14px 16px", background: C.card}}>
      <div style={{color:C.purpleL, fontSize:12, fontWeight:"bold", fontFamily:MN, letterSpacing:1.5, marginBottom:16, borderBottom:`1px solid ${C.border}`, paddingBottom:6}}>
        LIVE AGENT FLEET TELEMETRY & PERFORMANCE METRICS
      </div>
      <div style={{display:"flex", overflowX:"auto", gap: 14, paddingBottom: 8}} className="agent-scroll">
        {AGENT_NAMES.map((name, i) => {
          const isCore = i === 0;
          const sec = new Date().getSeconds();
          const active = isCore || ((i * 7 + sec) % AGENT_NAMES.length) < (AGENT_NAMES.length / 2.5); 
          const status = isCore ? "SYSTEM CORE" : (active ? "ACTIVE RUN" : "STANDBY");
          const col = isCore ? C.amber : (active ? C.green : C.dim);
          
          // Generate deterministic but changing pseudo-metrics
          const cpu = active ? (40 + (i*13 + sec)%50) : (1 + (i*7)%5);
          const mem = (120 + (i*47) % 800) + (active ? (sec%20) : 0);
          const tasks = 1200 + i*130 + (sec%60);
          const ping = 12 + (i*3 + sec)%40;
          const successRate = (98 + (i*7)%2 + (active ? 0.5 : 0)).toFixed(1);
          
          return (
            <div key={name} style={{flexShrink:0, width: 250, border:`1px solid ${C.border}`, padding:"10px 14px", background:C.panel, borderRadius:4, position:"relative", overflow:"hidden", boxShadow:`0 2px 8px rgba(0,0,0,0.3)`}}>
              {active && <div style={{position:"absolute", left:0, top:0, bottom:0, width:3, background: isCore ? C.orange : C.green}}/>}
              
              <Row style={{justifyContent:"space-between", marginBottom:10, paddingLeft: active ? 8 : 0, borderBottom:`1px dashed ${C.border}`, paddingBottom:6}}>
                <span style={{color:C.ink, fontSize:11, fontWeight:"bold", fontFamily:MN}}>{name}</span>
                <span style={{color:col, fontSize:10, fontWeight:"bold", fontFamily:MN}}>{status}</span>
              </Row>
              
              {/* Detailed Metrics Grid */}
              <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:"8px 12px", paddingLeft: active ? 8 : 0}}>
                <Row style={{justifyContent:"space-between"}}>
                  <span style={{color:C.dim2, fontSize:9, fontFamily:MN}}>CPU LOAD</span>
                  <span style={{color: active ? C.orange : C.ink, fontSize:10, fontFamily:MN, fontWeight:"bold"}}>{cpu}%</span>
                </Row>
                <Row style={{justifyContent:"space-between"}}>
                  <span style={{color:C.dim2, fontSize:9, fontFamily:MN}}>MEMORY</span>
                  <span style={{color:C.ink, fontSize:10, fontFamily:MN, fontWeight:"bold"}}>{mem} MB</span>
                </Row>
                <Row style={{justifyContent:"space-between"}}>
                  <span style={{color:C.dim2, fontSize:9, fontFamily:MN}}>LATENCY</span>
                  <span style={{color:C.ink, fontSize:10, fontFamily:MN, fontWeight:"bold"}}>{ping}ms</span>
                </Row>
                <Row style={{justifyContent:"space-between"}}>
                  <span style={{color:C.dim2, fontSize:9, fontFamily:MN}}>TASKS DONE</span>
                  <span style={{color:C.ink, fontSize:10, fontFamily:MN, fontWeight:"bold"}}>{tasks}</span>
                </Row>
                <Row style={{justifyContent:"space-between", gridColumn:"1 / -1", marginTop: 2}}>
                  <span style={{color:C.dim2, fontSize:9, fontFamily:MN}}>SUCCESS RATE</span>
                  <span style={{color:C.green, fontSize:10, fontFamily:MN, fontWeight:"bold"}}>{successRate}%</span>
                </Row>
              </div>
              
              {/* Mini activity sparkline / bar */}
              <div style={{marginTop: 10, paddingLeft: active ? 8 : 0}}>
                <div style={{display:"flex", gap:2, height:5}}>
                  {Array.from({length: 25}).map((_, j) => {
                    const isActiveBlock = active && ((j + sec) % 25 < 6);
                    return <div key={j} style={{flex:1, background: isActiveBlock ? col : C.border, borderRadius:1}}/>;
                  })}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </Panel>
  );

  /* ── Shared sections ── */
  const NetSection = ()=>(
    <Panel style={{marginBottom:8}}>
      <Row style={{justifyContent:"space-between",padding:"5px 10px",
        borderBottom:`1px solid ${C.border}`,background:C.card}}>
        <Row style={{gap:8}}>
          <Bdg col={C.panel} bg={C.orange} filled>SCANNING</Bdg>
          <span style={{color:C.ink,fontSize:11,fontFamily:MN,fontWeight:500}}>
            Ponyou · Relationship Graph Simulation
          </span>
        </Row>
        <Row style={{gap:mobile?8:14}}>
          {(mobile?[["STRATEGY", botState?.config?.strategy||"AUTO"]]:[["MODE",botState?.config?.executionMode||"AUTO"],["CAST-NET",castNetData?.enabled?"ACTIVE":"STANDBY"],["SAFETY",panopticonData?.marketIntel?.safetyScore?.toFixed(1)||"98.5"]]).map(([k,v])=>(
            <span key={k} style={{fontSize:10}}>
              <Lbl>{k} </Lbl><span style={{color:C.purple,fontWeight:500}}>{v}</span>
            </span>
          ))}
        </Row>
      </Row>
      {/* Agent current task bar */}
      <div style={{padding:"8px 14px",borderBottom:`1px solid ${C.border}`,
        background:C.card,display:"flex",gap:12,alignItems:"center"}}>
        <span style={{color:C.orange,fontSize:11,fontWeight:"bold",fontFamily:MN,letterSpacing:1,flexShrink:0}}>
          ⟳ AGENT TASK :
        </span>
        <span style={{color:C.ink,fontSize:11,fontFamily:MN,flex:1,fontWeight:500,letterSpacing:0.5}}>Monitoring Solana Mempool for anomalies...</span>
        <div style={{width:140,height:4,background:C.border,borderRadius:2,overflow:"hidden"}}>
          <div style={{height:"100%",background:C.orange,
            width:`75%`,transition:"width .8s ease"}}/>
        </div>
        <span style={{color:C.orange,fontSize:11,fontWeight:"bold",fontFamily:MN}}>
          75%
        </span>
      </div>
      {/* Body */}
      {mobile?(
        <NetGraph mobile={mobile} msgs={agentMsgs} secondBrain={botState?.second_brain}/>
      ):(
        <div style={{display:"grid",gridTemplateColumns:"1fr 180px"}}>
          <NetGraph mobile={false} msgs={agentMsgs} secondBrain={botState?.second_brain}/>
          {/* Market data */}
          <div style={{padding:"14px 16px",borderLeft:`1px solid ${C.border}`, display:"flex", flexDirection:"column", background:C.card}}>
            <div style={{color:C.purpleL, fontSize:12, fontWeight:"bold", fontFamily:MN, letterSpacing:1.5, marginBottom:16, borderBottom:`1px solid ${C.border}`, paddingBottom:6}}>
              NETWORK HUB
            </div>
            <div style={{display:"flex", flexDirection:"column", gap:14, flex:1}}>
              {[{l:"MARKET REGIME",v:panopticonData?.marketIntel?.currentRegime || "BULLISH",c:C.green},
                {l:"CONTAGION RISK",v:(panopticonData?.marketIntel?.contagionRisk * 100).toFixed(0)+"%" || "12%",c:C.amber},
                {l:"BLACKLISTED",v:(Object.keys(panopticonData?.rugMemory || {}).length) + " TOKENS",c:C.red},
                {l:"SOCIAL SIGNALS",v:panopticonData?.socialSignals?.metrics?.signalsExtracted || "104",c:C.green}].map(({l,v,c})=>(
                <div key={l}>
                  <div style={{color:C.dim2, fontSize:10, fontFamily:MN, marginBottom:4}}>{l}</div>
                  {v&&<div style={{color:c||C.ink,fontSize:14,fontWeight:"bold",fontFamily:MN}}>{v}</div>}
                </div>
              ))}
              
              {/* Mempool Pulse Gauge */}
              <div style={{marginTop: "auto", paddingTop: 12, borderTop: `1px dashed ${C.border}`, display:"flex", alignItems:"center", justifyContent:"space-between"}}>
                <div style={{display:"flex", flexDirection:"column"}}>
                  <span style={{color:C.dim2, fontSize:9, fontFamily:MN}}>SOLANA MEMPOOL</span>
                  <span style={{color:C.orange, fontSize:12, fontWeight:"bold", fontFamily:MN}}>{(2800 + Math.random()*200).toFixed(0)} TPS</span>
                </div>
                <div style={{width:26, height:26, borderRadius:"50%", border:`2px solid ${C.orange}55`, position:"relative", display:"flex", alignItems:"center", justifyContent:"center", boxShadow:`0 0 10px ${C.orange}44`}}>
                  <div style={{width:12, height:12, borderRadius:"50%", background:C.orange, animation:"pulse 0.8s infinite"}}/>
                </div>
              </div>
            </div>
            <button style={{width:"100%",marginTop:16,
              background:C.purple,color:"#FFF",border:"none",cursor:"pointer",
              padding:"8px 0",fontFamily:MN,fontWeight:"bold",fontSize:11,letterSpacing:1,
              boxShadow:`0 2px 10px ${C.purple}55`}}>
              ENABLE CAST-NET
            </button>
          </div>
        </div>
      )}
    </Panel>
  );

  const isPaper = botState?.features?.paper_trading;

  const CashSection = ()=>(
    <Panel style={{padding:"8px 10px"}} accent>
      <Row style={{gap:6,marginBottom:5,flexWrap:"wrap"}}>
        <Bdg col={C.purple}>PORTFOLIO</Bdg>
        <Lbl>Total Capital (SOL)</Lbl>
        <Bdg col={isPaper ? C.dim2 : C.orange}>{isPaper ? "PAPER TRADING" : "LIVE"}</Bdg>
      </Row>
      <Row style={{gap:14,marginBottom:1}}>
        <PixNum val={grpA} prefix="" size={30} col={C.orange}/>
        <PixNum val={"."+grpB} prefix="" size={30} col={C.orangeL}/>
      </Row>
      <div style={{color:inc>=0?C.green:C.red,fontSize:9,marginBottom:8,fontFamily:MN}}>{inc>=0?'+':''}${Math.abs(inc).toFixed(2)} TODAY</div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"4px 8px",marginBottom:8}}>
        {[["OPEN POS",tradesCount],["WIN RATE",`${winRate}%`],["AVG WIN","+$12"],["SHARPE","2.82"]].map(([k,v])=>(
          <div key={k}><Lbl>{k}</Lbl>
            <div style={{color:C.ink,fontWeight:"bold",fontSize:10,fontFamily:MN}}>{v}</div>
          </div>
        ))}
      </div>
      <Lbl>RECENT PERFORMANCE</Lbl>
      <ResponsiveContainer width="100%" height={56}>
        <BarChart data={winBars} barCategoryGap={1} margin={{top:4,bottom:0,left:0,right:0}}>
          <Bar dataKey="v" isAnimationActive={false}>
            {winBars.map((d,i)=><Cell key={i} fill={d.v>=0?C.green:C.red}/>)}
          </Bar>
          <XAxis hide/><YAxis hide/>
        </BarChart>
      </ResponsiveContainer>
    </Panel>
  );

  const PnlSection = ()=>(
    <Panel style={{padding:"8px 10px"}} accent>
      <Row style={{justifyContent:"space-between",marginBottom:6}}>
        <Row style={{gap:8}}>
          <span style={{color:C.ink,fontFamily:MN,fontWeight:500}}>PnL Curve</span>
          <Lbl>TODAY</Lbl>
        </Row>
        <Row style={{gap:12}}>
          <span style={{color:inc>=0?C.green:C.red,fontSize:9,fontFamily:MN}}>NET {inc>=0?'+':''}${Math.abs(inc).toFixed(2)}</span>
        </Row>
      </Row>
      <div style={{display:"grid",gridTemplateColumns:mobile?"1fr":"1fr 115px",gap:8}}>
        <ResponsiveContainer width="100%" height={mobile?88:120}>
          <LineChart data={pnlData}>
            <Line type="monotone" dataKey="v" stroke={C.orange} dot={false}
              strokeWidth={1.8} isAnimationActive={false}/>
            <XAxis dataKey="i" hide/><YAxis hide/>
          </LineChart>
        </ResponsiveContainer>
        {!mobile&&(
          <div style={{background:C.card,border:`1px solid ${C.border}`,padding:"7px 8px", overflowY: "auto", maxHeight: 120}}>
            <Lbl>ACTIVE POSITIONS</Lbl>
            {(!botState?.positions || botState.positions.length === 0) ? (
              <div style={{color:C.dim,fontSize:10,fontFamily:MN,padding:"10px 0",textAlign:"center"}}>No open positions</div>
            ) : botState.positions.map((p,i) => (
              <div key={i} style={{display:"flex",justifyContent:"space-between",marginTop:5, borderBottom:`1px dashed ${C.border}`, paddingBottom: 2}}>
                <span style={{color:C.ink, fontSize:10, fontFamily:MN, fontWeight:"bold"}}>{p.symbol}</span>
                <span style={{color:p.pnl_pct>=0?C.green:C.red,fontSize:9,fontFamily:MN,fontWeight:500}}>{p.pnl_pct>=0?'+':''}{p.pnl_pct.toFixed(2)}%</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </Panel>
  );

  const SubAgentLogs = ({ msgs }) => {
    const mkts = msgs.filter(m => m.type === "MARKET").slice(0, 8);
    const scrns = msgs.filter(m => m.type === "SCREENING").slice(0, 8);
    const ports = msgs.filter(m => m.type === "PORTFOLIO").slice(0, 8);

    const Col = ({ title, data, color }) => (
      <div style={{background: "#050505", border: `1px solid ${C.border}`, padding: "10px", display: "flex", flexDirection: "column"}}>
        <div style={{color, fontSize: 11, fontWeight: "bold", fontFamily: MN, letterSpacing: 1, marginBottom: 8, borderBottom: `1px solid ${C.border}`, paddingBottom: 6}}>
          {title}
        </div>
        <div style={{display: "flex", flexDirection: "column", gap: 6, overflowY: "auto", maxHeight: 110, fontFamily: MN}}>
          {data.length === 0 ? <div style={{color: C.dim, fontSize: 10}}>Awaiting data...</div> : data.map(m => (
            <div key={m.id} style={{display: "flex", gap: 6, borderBottom: `1px dashed #151515`, paddingBottom: 4, alignItems: "flex-start"}}>
              <span style={{color: C.dim, fontSize: 9, flexShrink: 0}}>[{m.time}]</span>
              <span style={{color: "#e0e0e0", fontSize: 10, lineHeight: 1.4, wordBreak: "break-word"}}>{m.text}</span>
            </div>
          ))}
        </div>
      </div>
    );

    return (
      <Panel style={{padding: "10px", marginTop: 8}}>
        <Lbl style={{marginBottom: 8}}>SUB-AGENT LIVE TELEMETRY</Lbl>
        <div style={{display: "flex", gap: 8, flexDirection: "column"}}>
          <Col title="HUNTERS (Market)" data={mkts} color={C.orange} />
          <Col title="SCREENING (Guard)" data={scrns} color={C.purpleL} />
          <Col title="MANAGEMENT (Portfolio)" data={ports} color={C.green} />
        </div>
      </Panel>
    );
  };

  const WalletTopology = () => {
    const topo = botState?.wallet_topology;
    if (!topo) return null;
    const isMulti = topo.multi_wallet_enabled;
    const modeStr = isMulti ? "[MULTI-WALLET CLUSTER]" : "[SINGLE-NODE]";
    
    return (
      <Panel style={{padding: "10px", marginTop: 8}}>
        <div style={{display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8}}>
          <Lbl>WALLET TOPOLOGY</Lbl>
          <span style={{fontSize: 9, fontFamily: MN, color: isMulti ? C.orange : C.dim, letterSpacing: 1}}>{modeStr}</span>
        </div>
        <div style={{display: "flex", flexDirection: "column", gap: 6}}>
          {!isMulti && topo.wallets.length === 0 ? (
            <div style={{color: C.dim, fontSize: 10, fontFamily: MN, padding: "4px 0"}}>System running on primary root wallet.</div>
          ) : topo.wallets.map((w, i) => {
            const isHot = w.status === "hot";
            const isCold = w.status === "cold";
            const color = isHot ? C.green : (isCold ? C.red : C.dim);
            return (
              <div key={i} style={{display: "flex", justifyContent: "space-between", alignItems: "center", background: "#050505", border: `1px solid ${w.is_active ? C.orange : C.border}`, padding: "6px 8px", borderRadius: 4}}>
                <div style={{display: "flex", alignItems: "center", gap: 8}}>
                  <div style={{width: 6, height: 6, borderRadius: "50%", background: color, boxShadow: `0 0 6px ${color}`}}></div>
                  <span style={{color: C.ink, fontSize: 10, fontFamily: MN, fontWeight: w.is_active ? "bold" : "normal"}}>{w.label}</span>
                  {w.is_active && <span style={{fontSize: 8, color: C.orange, fontFamily: MN}}>(ACTIVE)</span>}
                </div>
                <div style={{display: "flex", alignItems: "center", gap: 12}}>
                  <span style={{color: C.dim, fontSize: 9, fontFamily: MN}}>ERR: {w.error_count}</span>
                  <span style={{color: C.dim2, fontSize: 9, fontFamily: MN}}>{w.capital_pct}%</span>
                  <span style={{color: C.dim, fontSize: 9, fontFamily: PX}}>{w.address.slice(0, 4)}..{w.address.slice(-4)}</span>
                </div>
              </div>
            );
          })}
        </div>
      </Panel>
    );
  };

  const Footer = ()=>(
    <div style={{marginTop:8,padding:"5px 0",borderTop:`1px solid ${C.border}`,
      display:"flex",justifyContent:"space-between",alignItems:"center"}}>
      <Lbl>SYSTEM: PONYOU CORE · SOLANA MAINNET</Lbl>
      <Row style={{gap:8}}>
        <Lbl col={C.dim}>SYSTEM</Lbl>
        <span style={{color:C.orange,fontSize:9,fontFamily:MN,letterSpacing:1.5}}>ORCHESTRA</span>
        <div style={{width:6,height:6,borderRadius:"50%",background:C.orange,
          boxShadow:"0 0 6px "+C.orange,animation:"blink 1.2s ease-in-out infinite"}}/>
        <Lbl col={C.orange}>AI AGENT v2.1 LIVE</Lbl>
      </Row>
    </div>
  );

  /* ══════════════════ MOBILE LAYOUT ═══════════════════════ */
  if(mobile) return (
    <div style={{background:C.bg,fontFamily:MN,fontSize:11,color:C.ink,
      minHeight:"100vh",padding:"6px 8px",boxSizing:"border-box"}}>
      <style>{GCSS}</style>

      {/* Header */}
      <Panel style={{padding:"9px 10px",marginBottom:0}} accent>
        <Row style={{justifyContent:"space-between",marginBottom:6}}>
          <Lbl>PONYOU · LIVE · 2026</Lbl>
          <Row style={{gap:6}}>
            <div style={{fontFamily:PX,fontSize:15,color:C.ink,
              background:C.card,padding:"0 7px",border:`1px solid ${C.border}`}}>
              <LiveClock/>
            </div>
          </Row>
        </Row>
        <Row style={{justifyContent:"space-between",alignItems:"flex-start"}}>
          <div>
            <div style={{color:C.orange,fontWeight:"bold",fontSize:13,fontFamily:MN}}>PONYOU</div>
            <div style={{color:C.orangeL,letterSpacing:1.5,fontSize:9.5,marginTop:2,fontFamily:MN}}>
              AUTONOMOUS TRADING ENGINE
            </div>
          </div>
          <Bdg col={C.amber}>★ SOLANA</Bdg>
        </Row>
      </Panel>

      <AgentTicker msgs={agentMsgs}/>

      {/* Counter */}
      <Panel style={{padding:"10px 12px",marginBottom:8,marginTop:8}} accent>
        <Row style={{gap:6,marginBottom:6}}>
          <Lbl>TOTAL CAPITAL (SOL)</Lbl>
          <Bdg col={C.green}><LiveDot/> LIVE</Bdg>
        </Row>
        <Row style={{gap:10,alignItems:"center",marginBottom:8}}>
          <ClaudeOrb size={54}/>
          <div>
            <Row style={{gap:10}}>
              <PixNum val={grpA} prefix="" size={52} col={C.orange}/>
              <PixNum val={"."+grpB} prefix="" size={52} col={C.orangeL}/>
            </Row>
            <div style={{color:inc>=0?C.green:C.red,fontSize:9,marginTop:1,fontFamily:MN}}>{inc>=0?'+':''}${Math.abs(inc).toFixed(2)} TODAY</div>
          </div>
        </Row>
        <Row style={{gap:8,marginBottom:5,flexWrap:"wrap"}}>
          <Bdg col={C.orange}>{tradesCount} POSITIONS</Bdg>
          <Bdg col={C.green}>{winRate}% WIN</Bdg>
        </Row>
        <SegBar pct={botState?.win_rate || .78}/>
      </Panel>

      {NetSection()}
      <WalletTopology />
      {BrainMonitorSection()}

      <Panel style={{padding:"10px 12px",marginBottom:8}} accent>
        <Row style={{gap:6,marginBottom:8}}>
          <Bdg col={C.purple}>CASH FLOW</Bdg>
        </Row>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"8px 16px",marginBottom:8}}>
          {[["POSITIONS",tradesCount,C.orange],["WIN RATE",`${winRate}%`,C.green],
            ["AVG WIN","+$12",C.amber],["SHARPE","2.82",C.ink]].map(([k,v,c])=>(
            <div key={k}><Lbl>{k}</Lbl>
              <div style={{color:c,fontWeight:"bold",fontSize:13,fontFamily:MN}}>{v}</div>
            </div>
          ))}
        </div>
      </Panel>

      {PnlSection()}

      <SubAgentLogs msgs={agentMsgs} />

      {SkillRadarSection()}

      {/* Mobile Agent Log */}
      <Panel style={{marginBottom:8,height:220}} accent>
        <GlobalDataStream msgs={agentMsgs}/>
      </Panel>

      {Footer()}
    </div>
  );

  /* ══════════════════ DESKTOP LAYOUT ══════════════════════ */
  return (
    <div style={{background:C.bg,fontFamily:MN,fontSize:11,color:C.ink,
      minHeight:"100vh",padding:"7px 14px",boxSizing:"border-box"}}>
      <style>{GCSS}</style>

      {/* Micro top bar */}
      <div style={{display:"flex",justifyContent:"space-between",
        borderBottom:`1px solid ${C.border}`,paddingBottom:3,marginBottom:6,position:"relative"}}>
        <div style={{position:"absolute",bottom:0,left:0,right:0,height:1,
          background:`linear-gradient(to right,${C.orange}44,${C.purple}44,${C.orange}44)`}}/>
        <Lbl>PONYOU · LIVE · 2026 · SOLANA</Lbl>
        <Row style={{gap:8}}>
          <Lbl col={C.dim}>SYSTEM</Lbl>
          <span style={{color:C.orange,fontSize:9,fontFamily:MN,letterSpacing:1.5}}>ORCHESTRA</span>
          <Lbl>V2.1</Lbl>
        </Row>
      </div>

      {/* Header */}
      <Row style={{justifyContent:"space-between",alignItems:"center",marginBottom:0,position:"relative"}}>
        <div style={{position:"absolute",top:0,right:0,width:"45%",height:2,opacity:.6,
          background:`linear-gradient(to left,transparent,${C.purple},${C.orange})`}}/>
        <Row style={{gap:8}}>
          <span style={{color:C.orange,fontWeight:"bold",fontSize:14,fontFamily:MN}}>PONYOU</span>
          <Lbl> · </Lbl>
          <span style={{color:C.orangeD,letterSpacing:2.5,fontSize:11,fontFamily:MN}}>
            AUTONOMOUS TRADING ENGINE
          </span>
        </Row>
        <Row style={{gap:10}}>
          <Bdg col={C.amber}>★ SOLANA NETWORK</Bdg>
          <div style={{fontFamily:PX,fontSize:20,color:C.ink,letterSpacing:2.5,
            background:C.card,padding:"1px 10px",
            border:`1px solid ${C.border}`,
            boxShadow:`0 1px 3px ${C.sh}`}}><LiveClock/></div>
        </Row>
      </Row>

      {/* Agent ticker */}
      <div style={{marginBottom:8,marginTop:6}}>
        <AgentTicker msgs={agentMsgs}/>
      </div>

      {/* Counter + Biggest Win */}
      <div style={{display:"grid",gridTemplateColumns:"1fr 232px",gap:8,marginBottom:8}}>
        <Panel style={{padding:"8px 12px"}} accent>
          <Row style={{gap:8,marginBottom:4}}>
            <Lbl>TOTAL CAPITAL (SOL)</Lbl>
            <Bdg col={C.green}><LiveDot/> LIVE</Bdg>
          </Row>
          <Row style={{justifyContent:"space-between", alignItems:"center"}}>
            <Row style={{gap:14,alignItems:"center",marginBottom:7}}>
              <ClaudeOrb size={62}/>
              <Row style={{gap:18}}>
                <PixNum val={grpA} prefix="" size={68} col={C.orange}/>
                <PixNum val={"."+grpB} prefix="" size={68} col={C.orangeL}/>
              </Row>
            </Row>
            {/* Holographic Donut Chart */}
            <div style={{width: 130, height: 80, position:"relative"}}>
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={[
                      { name: "SOL", value: 45 },
                      { name: "STABLE", value: 30 },
                      { name: "MEME", value: 15 },
                      { name: "OTHER", value: 10 }
                    ]}
                    cx="50%" cy="50%" innerRadius={24} outerRadius={34}
                    stroke="none"
                    paddingAngle={4}
                    dataKey="value"
                    isAnimationActive={false}
                  >
                    <Cell fill={C.green} />
                    <Cell fill={C.amber} />
                    <Cell fill={C.orange} />
                    <Cell fill={C.purple} />
                  </Pie>
                </PieChart>
              </ResponsiveContainer>
              <div style={{position:"absolute", right: -5, top: "50%", transform:"translateY(-50%)", display:"flex", flexDirection:"column", gap: 3}}>
                <div style={{color:C.green, fontSize:8, fontFamily:MN}}><span style={{display:"inline-block",width:6,height:6,background:C.green,borderRadius:"50%",marginRight:3}}/>SOL</div>
                <div style={{color:C.amber, fontSize:8, fontFamily:MN}}><span style={{display:"inline-block",width:6,height:6,background:C.amber,borderRadius:"50%",marginRight:3}}/>USDC</div>
                <div style={{color:C.orange, fontSize:8, fontFamily:MN}}><span style={{display:"inline-block",width:6,height:6,background:C.orange,borderRadius:"50%",marginRight:3}}/>MEME</div>
              </div>
            </div>
          </Row>
          <Row style={{gap:5,marginBottom:3}}>
            <Lbl col={C.orange}>{tradesCount} POSITIONS</Lbl>
            <Lbl> · ALL · </Lbl>
            <Lbl col={C.green}>{winRate}% WIN</Lbl>
          </Row>
          <div>
            <span style={{color:inc>=0?C.green:C.red,fontSize:9,fontFamily:MN}}> {inc>=0?'+':''}${Math.abs(inc).toFixed(2)} TODAY</span>
          </div>
          <SegBar pct={botState?.win_rate || .78}/>
        </Panel>

        <div style={{border:`1px solid ${C.amberL}55`,background:C.card,
          padding:"9px 10px",position:"relative",overflow:"hidden",
          boxShadow:`0 1px 4px ${C.amberG}`}}>
          <div style={{position:"absolute",top:0,left:0,right:0,height:2,background:C.amber}}/>
          <Lbl col={C.amber}>MARKET INTELLIGENCE</Lbl>
          <div style={{marginTop:8, display:"flex", flexDirection:"column", gap: 8}}>
            <Row style={{justifyContent:"space-between", borderBottom:`1px dashed ${C.border}`, paddingBottom: 4}}>
              <Lbl>REGIME</Lbl>
              <span style={{color:C.green, fontFamily:MN, fontSize:11, fontWeight:"bold"}}>{panopticonData?.marketIntel?.currentRegime || "BULLISH"}</span>
            </Row>
            <Row style={{justifyContent:"space-between", borderBottom:`1px dashed ${C.border}`, paddingBottom: 4}}>
              <Lbl>RISK SCORE</Lbl>
              <span style={{color:C.amber, fontFamily:MN, fontSize:11, fontWeight:"bold"}}>{(panopticonData?.marketIntel?.contagionRisk * 100).toFixed(0)+"%" || "12%"}</span>
            </Row>
            <Row style={{justifyContent:"space-between"}}>
              <Lbl>BLACKLIST</Lbl>
              <span style={{color:C.red, fontFamily:MN, fontSize:11, fontWeight:"bold"}}>{(Object.keys(panopticonData?.rugMemory || {}).length)} TOKENS</span>
            </Row>
          </div>
        </div>
      </div>

      {NetSection()}
      <WalletTopology />
      {BrainMonitorSection()}
      {AgentFleetGrid()}

      {/* Bottom 2-col: Cash | PnL */}
      <div style={{display:"grid",gridTemplateColumns:mobile?"1fr":"240px 1fr",gap:8, marginTop:8}}>
        {CashSection()}
        {PnlSection()}
      </div>

      <SubAgentLogs msgs={agentMsgs} />

      {SkillRadarSection()}

      {/* Massive Data Stream Terminal */}
      <Panel style={{marginTop: 8, padding: 0, height: 350, background: "#050505", border:`1px solid ${C.purpleL}44`}} shadow={false}>
        <GlobalDataStream msgs={agentMsgs}/>
      </Panel>

      {Footer()}
    </div>
  );
}
