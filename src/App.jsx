import React, { useMemo, useState } from 'react';
import {
  Activity, ArrowRight, Bell, BookOpen, CalendarDays, Check, ChevronDown,
  ChevronRight, CircleHelp, ClipboardList, FileText, Flag, Handshake,
  HeartHandshake, Home, Landmark, Menu, MessageCircle, Plus, Search,
  ShieldCheck, Sparkles, Users, Vote, X, Send, Clock3, MapPin, LogOut,
  PanelLeftClose
} from 'lucide-react';
import { agenda, motions as initialMotions, forums as initialForums, members } from './data';

const navGroups = [
  { label: 'WORKSPACE', items: [
    ['Overview', Home], ['Assembly Hall', Landmark], ['Order Paper', ClipboardList],
    ['Motions & Voting', Vote], ['Members Register', Users], ['Hansard & Records', BookOpen]
  ]},
  { label: 'CHILDREN’S VOICES', items: [
    ['Open Forums', MessageCircle], ['Community Proposals', Flag], ['Stakeholder Action', Handshake]
  ]}
];

function App() {
  const [active, setActive] = useState('Overview');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [showLogin, setShowLogin] = useState(false);
  const [loginMode, setLoginMode] = useState('child');
  const [loginUsername, setLoginUsername] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [picturePassphrase, setPicturePassphrase] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [role, setRole] = useState('Assembly Secretariat');
  const [name, setName] = useState('Guest');
  const [modal, setModal] = useState('');
  const [search, setSearch] = useState('');
  const [motions, setMotions] = useState(initialMotions);
  const [forums, setForums] = useState(initialForums);
  const [notice, setNotice] = useState('');
  const [proposal, setProposal] = useState('');
  const [proposalTitle, setProposalTitle] = useState('');
  const [selectedMotion, setSelectedMotion] = useState(null);

  const filteredMembers = useMemo(() => members.filter(m => (m.name + m.ward).toLowerCase().includes(search.toLowerCase())), [search]);

  const notify = (message) => { setNotice(message); window.setTimeout(() => setNotice(''), 3200); };
  const navigate = (page) => { setActive(page); setSidebarOpen(false); setSearch(''); };
  const submitProposal = (e) => {
    e.preventDefault();
    if (!proposalTitle.trim() || !proposal.trim()) return;
    setForums([{ title: proposalTitle, category: 'Community proposal', replies: 0, color: 'blue', text: proposal }, ...forums]);
    setProposal(''); setProposalTitle(''); setModal('');
    notify('Your contribution has been added to this local demo.');
  };

  const pageTitle = active === 'Overview' ? 'Good afternoon' : active;
  const pageDescription = active === 'Overview'
    ? 'Here is what is happening across the Mombasa County Children E-Assembly.'
    : descriptions[active] || 'A shared space for children to participate, deliberate and follow up on issues that matter.';

  return <div className="app-shell">
    <aside className={`sidebar ${sidebarOpen ? 'sidebar-open' : ''}`}>
      <div className="brand">
        <div className="brand-mark"><Landmark size={23}/></div>
        <div><strong>MCCeAS</strong><span>SAUTI YETU · MOMBASA</span></div>
        <button className="icon-btn sidebar-close" onClick={() => setSidebarOpen(false)} aria-label="Close menu"><X size={18}/></button>
      </div>
      <div className="workspace-label">DIGITAL ASSEMBLY</div>
      <div className="profile-switch">
        <div className="profile-avatar">VO</div><div className="profile-copy"><b>{signedIn ? name : 'Assembly workspace'}</b><span>{signedIn ? role : 'Public demonstration'}</span></div><ChevronDown size={15}/>
      </div>
      <nav className="side-nav">
        {navGroups.map(group => <div className="nav-group" key={group.label}>
          <p>{group.label}</p>
          {group.items.map(([label, Icon]) => <button key={label} onClick={() => navigate(label)} className={active === label ? 'nav-link active' : 'nav-link'}><Icon size={18}/><span>{label}</span>{label === 'Open Forums' && <span className="nav-count">3</span>}</button>)}
        </div>)}
      </nav>
      <div className="sidebar-bottom">
        <div className="safety-card"><div className="safety-icon"><ShieldCheck size={18}/></div><b>Your voice matters</b><p>Speak up respectfully. Your safety and privacy come first.</p><button onClick={() => setModal('safety')}>Safety guidelines <ArrowRight size={13}/></button></div>
        <div className="sidebar-foot"><span className="online-dot"/> Demonstration environment <span>v1.0</span></div>
      </div>
    </aside>
    {sidebarOpen && <button className="mobile-scrim" onClick={() => setSidebarOpen(false)} aria-label="Close navigation"/>}
    <main className="main-area">
      <header className="topbar">
        <div className="top-left"><button className="icon-btn menu-btn" onClick={() => setSidebarOpen(true)} aria-label="Open menu"><Menu size={20}/></button><div className="crumb">MCCeAS <ChevronRight size={14}/><b>{active}</b></div></div>
        <div className="top-actions"><div className="session-pill"><span/> DEMO MODE</div><button className="icon-btn notification-btn" onClick={() => notify('You are all caught up.')} aria-label="Notifications"><Bell size={19}/><i/></button><button className="user-chip" onClick={() => setShowLogin(true)}><span className="user-avatar">{signedIn ? name.slice(0,1).toUpperCase() : 'G'}</span><span>{signedIn ? name : 'Guest'}</span><ChevronDown size={14}/></button></div>
      </header>
      <div className="page-content">
        <section className="page-heading"><div><div className="eyebrow"><span className="eyebrow-line"/>{active === 'Overview' ? 'THURSDAY, 05 NOVEMBER 2026' : 'MOMBASA COUNTY CHILDREN E-ASSEMBLY'}</div><h1>{pageTitle}{active === 'Overview' && <span className="heading-name">, {signedIn ? name.split(' ')[0] : 'delegate'}</span>}</h1><p>{pageDescription}</p></div><div className="heading-buttons"><button className="button button-light" onClick={() => setModal('agenda')}><CalendarDays size={16}/> View calendar</button><button className="button button-primary" onClick={() => setModal('proposal')}><Plus size={17}/> Submit a voice</button></div></section>

        {active === 'Overview' && <Overview motions={motions} forums={forums} onNavigate={navigate} onOpen={setModal} onMotion={setSelectedMotion}/>}
        {active === 'Assembly Hall' && <AssemblyHall onOpen={setModal}/>}
        {active === 'Order Paper' && <OrderPaper onOpen={setModal}/>}
        {active === 'Motions & Voting' && <Motions motions={motions} onMotion={setSelectedMotion} onOpen={setModal}/>}
        {active === 'Members Register' && <Members members={filteredMembers} search={search} setSearch={setSearch}/>}
        {active === 'Hansard & Records' && <Records/>}
        {active === 'Open Forums' && <Forums forums={forums} onOpen={setModal}/>}
        {active === 'Community Proposals' && <Proposals forums={forums} onOpen={setModal}/>}
        {active === 'Stakeholder Action' && <Stakeholder/>}

        <footer className="main-footer"><div><b>MCCeAS</b> · Mombasa County Children E-Assembly</div><div>Children’s participation. Shared responsibility. <span>© 2026</span></div></footer>
      </div>
    </main>

    {showLogin && <div className="modal-backdrop" onMouseDown={() => setShowLogin(false)}><div className="modal login-modal" onMouseDown={e => e.stopPropagation()}><button className="modal-x" onClick={() => setShowLogin(false)}><X size={18}/></button><div className="modal-symbol"><Landmark size={23}/></div><div className="eyebrow">MCCeAS SECURE ACCESS · UI PREVIEW</div><h2>Welcome to Sauti Yetu</h2><p className="muted">One access point for children, delegates and authorised adults.</p><div className="login-tabs"><button className={loginMode==='child'?'selected':''} onClick={()=>setLoginMode('child')}>Child / Delegate</button><button className={loginMode==='adult'?'selected':''} onClick={()=>setLoginMode('adult')}>Official / Stakeholder</button></div><form onSubmit={e => {e.preventDefault();setName(name==='Guest'?'Demo user':name);setSignedIn(true);setShowLogin(false);notify('Demo session started. No credentials were verified.')}}><label>{loginMode==='child'?'Guardian phone number':'Official work email'}</label><input value={loginUsername} onChange={e=>setLoginUsername(e.target.value)} placeholder={loginMode==='child'?'e.g. 0712 345 678':'name@organisation.go.ke'} autoComplete="username" required/><label>{loginMode==='child'?'Three-word passphrase':'Password'}</label><input type="password" value={loginPassword} onChange={e=>setLoginPassword(e.target.value)} placeholder={loginMode==='child'?'e.g. lion mango river':'Enter your password'} autoComplete="current-password" required/><div className="login-extra">{loginMode==='child'?<><button type="button" onClick={()=>setPicturePassphrase(!picturePassphrase)}>{picturePassphrase?'Use words instead':'Use picture passphrase'}</button><span>Forgot passphrase? Ask your registered guardian to reset it.</span></>:<span>Official accounts require administrator approval.</span>}</div>{picturePassphrase&&loginMode==='child'&&<div className="picture-passphrase"><button type="button" onClick={()=>notify('Picture passphrase is a visual prototype.')}>Lion</button><button type="button" onClick={()=>notify('Picture passphrase is a visual prototype.')}>Mango</button><button type="button" onClick={()=>notify('Picture passphrase is a visual prototype.')}>River</button></div>}<button className="button button-primary full" type="submit">Continue securely <ArrowRight size={16}/></button></form><div className="demo-warning"><ShieldCheck size={16}/> Prototype only. Sign-in is simulated; no account, password or guardian phone is verified or stored.</div><button className="register-link" onClick={()=>{setShowLogin(false);setModal('register')}}>New to Sauti Yetu? <b>Explore child registration</b></button></div></div>}

    {modal && <Modal type={modal} onClose={() => setModal('')} onSubmit={submitProposal} proposal={proposal} setProposal={setProposal} proposalTitle={proposalTitle} setProposalTitle={setProposalTitle} notify={notify}/>}
    {selectedMotion && <div className="modal-backdrop" onMouseDown={() => setSelectedMotion(null)}><div className="modal" onMouseDown={e => e.stopPropagation()}><button className="modal-x" onClick={() => setSelectedMotion(null)}><X size={18}/></button><div className="eyebrow">MOTION DETAILS · {selectedMotion.id}</div><h2>{selectedMotion.title}</h2><p className="muted">{selectedMotion.committee} · Submitted {selectedMotion.date}</p><div className="detail-stat"><span>Current status</span><b>{selectedMotion.status}</b></div><div className="detail-stat"><span>Recorded support (demo)</span><b>{selectedMotion.support} delegates</b></div><p className="muted small">Voting and delegate verification are not connected in this demonstration. No binding vote can be cast here.</p><button className="button button-primary full" onClick={() => setSelectedMotion(null)}>Close details</button></div></div>}
    {notice && <div className="toast"><Check size={17}/>{notice}</div>}
  </div>;
}

const descriptions = {
  'Assembly Hall': 'The formal workspace for verified delegates, scheduled sittings and parliamentary business.',
  'Order Paper': 'The proposed sequence of business for an Assembly sitting.',
  'Motions & Voting': 'Track motions, debate stages and recorded outcomes.',
  'Members Register': 'A demonstration directory of Assembly delegates and their roles.',
  'Hansard & Records': 'Browse sitting records, minutes and official documents.',
  'Open Forums': 'A public participation space where children can share experiences and ideas.',
  'Community Proposals': 'Ideas raised by children for discussion, referral and follow-up.',
  'Stakeholder Action': 'Follow the journey from children’s contributions to stakeholder responses.'
};

function SectionHeader({title, action, onAction}) { return <div className="section-head"><div><h2>{title}</h2></div>{action && <button className="text-action" onClick={onAction}>{action}<ArrowRight size={14}/></button>}</div>; }
function Overview({motions, forums, onNavigate, onOpen, onMotion}) {
  return <>
    <section className="hero-panel"><div className="hero-copy"><div className="hero-kicker"><span/> THE CHILDREN’S ASSEMBLY PLATFORM</div><h2>Every child has a voice.<br/><em>Every voice can move us forward.</em></h2><p>A shared digital space to deliberate, raise community priorities and follow up on the issues affecting children across Mombasa County.</p><div className="hero-actions"><button className="button button-white" onClick={() => onNavigate('Assembly Hall')}>Enter Assembly Hall <ArrowRight size={16}/></button><button className="hero-link" onClick={() => onNavigate('Open Forums')}>Explore children’s voices</button></div></div><div className="hero-art"><div className="orbit orbit-one"/><div className="orbit orbit-two"/><div className="hero-emblem"><Landmark size={45}/><span>SAUTI<br/>YETU</span></div><div className="floating-note note-one"><MessageCircle size={15}/> Ideas shared</div><div className="floating-note note-two"><Users size={15}/> Children first</div></div><div className="hero-bottom"><span><ShieldCheck size={15}/> Participation with dignity and safety</span><span>MOMBASA COUNTY <b>·</b> KENYA</span></div></section>
    <section className="stats-grid"><Stat icon={Users} label="Registered delegates" value="—" note="Verification not connected" /><Stat icon={CalendarDays} label="Assembly sittings" value="04" note="Illustrative schedule" /><Stat icon={FileText} label="Active motions" value={motions.filter(m=>m.status!=='Adopted').length.toString().padStart(2,'0')} note="Sample records" /><Stat icon={MessageCircle} label="Open discussions" value={forums.length.toString().padStart(2,'0')} note="Community themes" /></section>
    <div className="content-grid"><div className="content-main"><section className="panel"><SectionHeader title="Next Assembly sitting" action="Full order paper" onAction={() => onNavigate('Order Paper')}/><div className="sitting-card"><div className="date-block"><b>12</b><span>NOV</span><small>2026</small></div><div className="sitting-info"><span className="status-label"><i/> SCHEDULED · DEMO</span><h3>Children’s Assembly — Plenary Sitting</h3><p><Clock3 size={14}/> 9:00 AM – 1:00 PM <MapPin size={14}/> Mombasa County</p><span className="muted small">Agenda items are illustrative and subject to official confirmation.</span></div><button className="round-arrow" onClick={() => onNavigate('Order Paper')}><ArrowRight size={18}/></button></div></section>
    <section className="panel"><SectionHeader title="Business before the Assembly" action="View all motions" onAction={() => onNavigate('Motions & Voting')}/><div className="motion-list">{motions.slice(0,2).map(m=><button className="motion-row" key={m.id} onClick={() => onMotion(m)}><div className="motion-icon"><FileText size={18}/></div><div className="motion-copy"><b>{m.title}</b><span>{m.id} · {m.committee}</span></div><span className={`pill ${m.status==='Adopted'?'pill-green':''}`}>{m.status}</span><ChevronRight size={17}/></button>)}</div></section></div>
    <div className="content-side"><section className="panel"><SectionHeader title="Children’s voices" action="Open forums" onAction={() => onNavigate('Open Forums')}/><div className="forum-mini-list">{forums.slice(0,3).map((f,i)=><button className="forum-mini" key={f.title} onClick={() => onNavigate('Open Forums')}><span className={`forum-dot ${f.color}`}/><span><b>{f.title}</b><small>{f.replies} contributions · {f.category}</small></span><ChevronRight size={16}/></button>)}</div><button className="button button-outline full" onClick={() => onOpen('proposal')}><Plus size={16}/> Add your voice</button></section>
    <section className="impact-card"><div className="impact-icon"><HeartHandshake size={20}/></div><span className="eyebrow">FROM VOICE TO ACTION</span><h3>Participation should lead to a response.</h3><p>See how proposals can be referred, tracked and answered by relevant stakeholders.</p><button onClick={() => onNavigate('Stakeholder Action')}>Explore accountability <ArrowRight size={15}/></button></section></div></div>
    <section className="pillar-strip"><div><span>01</span><b>Official Assembly Hall</b><small>Deliberation & records</small></div><div><span>02</span><b>Open Child Participation</b><small>Ideas & community voices</small></div><div><span>03</span><b>Shared Accountability</b><small>Referrals & responses</small></div></section>
  </>;
}
function Stat({icon:Icon,label,value,note}) { return <div className="stat-card"><div className="stat-top"><span>{label}</span><Icon size={18}/></div><b>{value}</b><small>{note}</small></div>; }
function AssemblyHall({onOpen}) {
  const [queue,setQueue]=useState([{name:'Amina M.',ward:'Nyali',status:'Speaking'},{name:'Brian K.',ward:'Kisauni',status:'Next'},{name:'Wanjiru N.',ward:'Likoni',status:'Waiting'}]);
  const [vote,setVote]=useState('');
  const [requested,setRequested]=useState(false);
  const [seconds,setSeconds]=useState(120);
  const [mic,setMic]=useState(false);
  const cast=(choice)=>{setVote(choice);};
  return <>
    <div className="hall-topline"><div><span className="live-dot"/> LIVE ASSEMBLY HALL <small>DEMONSTRATION SESSION</small></div><span className="hall-sitting"><CalendarDays size={16}/> Sitting No. 04 · 12 Nov 2026</span></div>
    <div className="hall-grid">
      <section className="hall-stage">
        <div className="hall-stage-head"><span><span className="live-dot"/> LIVE · PLENARY CHAMBER</span><span>28 viewers · sample</span></div>
        <div className="speaker-screen"><div className="chamber-watermark"><Landmark size={56}/><b>SAUTI YETU</b><small>CHILDREN’S e-ASSEMBLY</small></div><div className="speaker-caption"><span className="speaker-avatar">AM</span><div><b>Hon. Amina M. — Nyali</b><small>Presiding speaker · Sample profile</small></div><div className="speaker-timer"><Clock3 size={15}/><b>{Math.floor(seconds/60)}:{String(seconds%60).padStart(2,'0')}</b><small>TIME REMAINING</small></div></div></div>
        <div className="hall-quorum"><div><b>Quorum</b><span>12 / 15 delegates present</span></div><div className="quorum-track"><i/></div><strong><Check size={14}/> Quorum met</strong></div>
        <div className="hall-controls"><button className={mic?'button button-primary':'button button-light'} onClick={()=>setMic(!mic)}><Activity size={15}/>{mic?'Microphone on':'Microphone muted'}</button><button className={requested?'button button-light':'button button-primary'} onClick={()=>{setRequested(!requested);if(!requested)setQueue(q=>[...q,{name:'You (demo)',ward:'Your ward',status:'Waiting'}]);else setQueue(q=>q.filter(p=>p.name!=='You (demo)'));}}><MessageCircle size={15}/>{requested?'Cancel request':'Request to speak'}</button><button className="button button-light" onClick={()=>onOpen('agenda')}><ClipboardList size={15}/> Order paper</button></div>
        <p className="hall-disclaimer">Video/audio streaming is not connected. The chamber panel is a visual prototype; no real meeting is taking place.</p>
      </section>
      <section className="panel hall-side"><SectionHeader title="Speaker queue"/><div className="queue-table"><div className="queue-head"><span>#</span><span>Delegate</span><span>Ward</span><span>Status</span></div>{queue.map((p,i)=><div className={p.status==='Speaking'?'queue-row speaking':''} key={p.name}><b>{i+1}</b><span>{p.name}</span><span>{p.ward}</span><em className={p.status.toLowerCase()}>{p.status}</em></div>)}</div>
        <div className="active-motion"><span className="eyebrow">ACTIVE MOTION</span><h3>Safe and inclusive learning spaces</h3><p>Motion MOT-026 · Education & Skills Committee</p><span className="pill">Under debate · Sample</span></div>
        <div className="vote-box"><SectionHeader title="Voting panel"/><p>How would you vote on this motion?</p><div className="vote-options">{['Yes','No','Abstain'].map(v=><button key={v} className={'vote-choice '+v.toLowerCase()+(vote===v?' chosen':'')} onClick={()=>cast(v)}><b>{v}</b><strong>{v==='Yes'?'12':v==='No'?'2':'1'}</strong><small>{v==='Yes'?'80%':v==='No'?'13%':'7%'}</small></button>)}</div>{vote&&<div className="vote-feedback"><Check size={14}/> Demo selection: {vote}. No ballot has been submitted or recorded.</div>}</div>
      </section>
    </div>
    <div className="hall-actionbar"><button onClick={()=>onOpen('agenda')}><ClipboardList size={17}/> Order Paper</button><button onClick={()=>onOpen('agenda')}><BookOpen size={17}/> Hansard</button><button onClick={()=>onOpen('safety')}><ShieldCheck size={17}/> Help & safety</button><button onClick={()=>onOpen('agenda')}><FileText size={17}/> Sitting records</button></div>
    <section className="panel hall-programme"><SectionHeader title="Sitting programme"/><Agenda/></section>
  </>;
}
function Agenda(){return <div className="agenda-list">{agenda.map((a,i)=><div className="agenda-item" key={a.title}><span className="agenda-time">{a.time}</span><span className="agenda-track"><i/></span><div><b>{a.title}</b><p>{a.detail}</p></div><span className="pill">{a.tag}</span></div>)}</div>}
function OrderPaper({onOpen}) { return <><div className="panel order-summary"><div><span className="eyebrow">PROPOSED ORDER PAPER · DEMO</span><h2>Plenary Sitting No. 04</h2><p className="muted">Thursday, 12 November 2026 · Mombasa County</p></div><button className="button button-primary" onClick={()=>onOpen('agenda')}><FileText size={16}/> View agenda</button></div><section className="panel"><SectionHeader title="Order of business"/><Agenda/><p className="footnote">This is a sample programme for interface demonstration only. It is not an adopted Order Paper or a substitute for approved Assembly Standing Orders.</p></section></>; }
function Motions({motions,onMotion,onOpen}) {return <><div className="toolbar"><div className="filter-label"><span className="filter-dot"/> All motions <span className="muted">({motions.length})</span></div><button className="button button-primary" onClick={()=>onOpen('proposal')}><Plus size={16}/> Raise a proposal</button></div><section className="panel"><div className="table-head"><span>Motion</span><span>Committee</span><span>Status</span><span>Support</span><span/></div>{motions.map(m=><button className="table-row" key={m.id} onClick={()=>onMotion(m)}><span><b>{m.title}</b><small>{m.id} · {m.date}</small></span><span>{m.committee}</span><span><i className="table-status"/> {m.status}</span><span>{m.support}</span><ChevronRight size={17}/></button>)}</section><p className="footnote">All motions and support counts shown are illustrative. No vote is being cast or stored.</p></>}
function Members({members,search,setSearch}) {return <><div className="toolbar"><div className="search-box"><Search size={17}/><input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search delegates or wards..."/></div><span className="muted small">Sample directory · {members.length} shown</span></div><section className="panel"><div className="table-head member-head"><span>Delegate</span><span>Ward</span><span>Role</span><span>Verification</span></div>{members.map(m=><div className="table-row member-row" key={m.name}><span className="member-name"><i>{m.initials}</i><b>{m.name}</b></span><span>{m.ward}</span><span>{m.role}</span><span className={m.status==='Verified'?'verified':'pending'}>{m.status==='Verified'?<Check size={14}/>:<Clock3 size={14}/>} {m.status}</span></div>)}</section><p className="footnote">Names and details are fictional sample records. A real register requires consent, verification and restricted access.</p></>}
function Records(){return <><div className="hansard-document"><div className="hansard-brand"><Landmark size={28}/><span>MOMBASA COUNTY CHILDREN E-ASSEMBLY</span><b>SAUTI YETU</b></div><div className="eyebrow">OFFICIAL RECORD TEMPLATE · DEMONSTRATION</div><h2>HANSARD — Sitting No. 04</h2><h3>Thursday, 12 November 2026 · Mombasa County</h3><p className="muted">Session status: Proposed · Document version: Draft template</p><div className="hansard-rule">MOTION & RESOLUTION REGISTER</div><div className="hansard-table"><b>Reference</b><b>Motion</b><b>Stage</b><span>MOT-026</span><span>Safe and inclusive learning spaces</span><strong>Under debate</strong><span>MOT-025</span><span>Access to safe drinking water in schools</span><strong>Committee review</strong></div><div className="hansard-rule">MINUTES EXCERPT</div><p className="hansard-minutes">This section is reserved for an approved, verified sitting transcript and minutes. No proceedings have been recorded by this demonstration.</p><div className="hansard-signatures"><span>Child Speaker signature: __________________</span><span>Clerk signature: __________________</span></div><div className="hansard-stamp">DRAFT<br/>TEMPLATE</div></div><div className="hansard-actions"><button className="button button-primary" onClick={()=>alert('PDF generation is not connected yet.') }><FileText size={16}/> Download PDF</button><button className="button button-light" onClick={()=>window.print()}><FileText size={16}/> Print template</button><button className="button button-outline" onClick={()=>alert('CSV export is not connected yet.')}>Export CSV</button></div><p className="footnote">An official Hansard must be generated from authenticated attendance, approved minutes and verified voting records. This page is a non-official layout prototype.</p></>}
function Forums({forums,onOpen}){return <><div className="notice-banner"><MessageCircle size={19}/><div><b>Open participation is not delegate voting</b><span>Any child may contribute to public discussions. Contributions do not grant parliamentary status or voting rights.</span></div></div><div className="forum-grid">{forums.map((f,i)=><article className="forum-card" key={f.title}><div className={`forum-card-icon ${f.color}`}>{i===0?<BookOpen size={21}/>:i===1?<HeartHandshake size={21}/>:<Activity size={21}/>}</div><span className="eyebrow">{f.category}</span><h3>{f.title}</h3><p>{f.text}</p><div className="forum-card-foot"><span><MessageCircle size={14}/>{f.replies} contributions</span><button onClick={()=>onOpen('proposal')}>Contribute <ArrowRight size={14}/></button></div></article>)}</div><p className="footnote">This demonstration does not publish content to a server. Real public forums need moderation, privacy controls and safeguarding escalation.</p></>}
function Proposals({forums,onOpen}){return <><div className="toolbar"><p className="muted">Ideas shared by children for discussion and possible referral.</p><button className="button button-primary" onClick={()=>onOpen('proposal')}><Plus size={16}/> New proposal</button></div><section className="panel">{forums.map((f,i)=><div className="record-row" key={f.title}><div className="proposal-number">{String(i+1).padStart(2,'0')}</div><div><b>{f.title}</b><small>{f.category} · {f.replies} contributions</small><p className="muted small">{f.text}</p></div><span className="pill">Received</span></div>)}</section><p className="footnote">A proposal is not automatically an Assembly motion or a government commitment.</p></>}
function Stakeholder(){return <><div className="impact-banner"><Handshake size={24}/><div><h2>From children’s priorities to shared action</h2><p>Track referrals, responses and commitments transparently — without promising outcomes outside the Assembly’s control.</p></div></div><section className="panel"><SectionHeader title="Illustrative action tracker"/><div className="action-track">{[['01','Children raise an issue','Contribution received','done'],['02','Assembly or committee reviews','Review and prioritisation','done'],['03','Referral to relevant stakeholder','Referral pending','current'],['04','Response and follow-up','Awaiting response','']].map(a=><div className="action-step" key={a[0]}><span className={`step-number ${a[3]}`}>{a[0]}</span><div><b>{a[1]}</b><small>{a[2]}</small></div><span className={`step-state ${a[3]}`}>{a[3]==='done'?'Completed':a[3]==='current'?'In progress':'Upcoming'}</span></div>)}</div></section><p className="footnote">This is a workflow illustration. No stakeholder has been contacted and no real-world action status is being represented.</p></>}
function Modal({type,onClose,onSubmit,proposal,setProposal,proposalTitle,setProposalTitle,notify}){const isProposal=type==='proposal';return <div className="modal-backdrop" onMouseDown={onClose}><div className="modal" onMouseDown={e=>e.stopPropagation()}><button className="modal-x" onClick={onClose}><X size={18}/></button>{isProposal?<><div className="modal-symbol"><MessageCircle size={22}/></div><div className="eyebrow">CHILDREN’S PARTICIPATION</div><h2>Share your voice</h2><p className="muted">Share an idea or concern respectfully. Please do not include private details about yourself or another child.</p><form onSubmit={onSubmit}><label>Give your idea a title</label><input value={proposalTitle} onChange={e=>setProposalTitle(e.target.value)} placeholder="What would you like to talk about?" required/><label>Your contribution</label><textarea value={proposal} onChange={e=>setProposal(e.target.value)} placeholder="Describe the issue or idea..." rows="5" required/><div className="form-note"><ShieldCheck size={15}/> Demo only: this contribution stays in this browser session and is not sent anywhere.</div><button className="button button-primary full" type="submit"><Send size={16}/> Add contribution</button></form></>:type==='register'?<><div className="modal-symbol"><Users size={22}/></div><div className="eyebrow">PUBLIC CHILD REGISTRATION · PREVIEW</div><h2>Create your Sauti Yetu profile</h2><p className="muted">A parent or guardian must provide consent before activation. Use sample details only in this prototype.</p><form onSubmit={e=>{e.preventDefault();notify('Registration preview complete. No personal data was saved.');onClose();}}><label>Child’s full name</label><input placeholder="Full name" required/><div className="register-grid"><div><label>Age</label><input type="number" min="5" max="17" placeholder="Age" required/></div><div><label>Gender (optional)</label><select><option>Prefer not to say</option><option>Female</option><option>Male</option><option>Other</option></select></div></div><label>School</label><input placeholder="School name" required/><div className="register-grid"><div><label>County</label><input placeholder="County" required/></div><div><label>Ward</label><input placeholder="Ward" required/></div></div><label>Guardian’s name</label><input placeholder="Guardian full name" required/><label>Guardian phone number</label><input type="tel" placeholder="07xx xxx xxx" required/><label>Three-word passphrase</label><input placeholder="e.g. lion mango river" required/><label className="consent-check"><input type="checkbox" required/> Guardian consent has been reviewed and granted.</label><button className="button button-primary full" type="submit">Preview registration <ArrowRight size={16}/></button></form><p className="footnote">Production requirements: verify consent, hash credentials, minimise child data and enforce safeguarding controls.</p></>:type==='agenda'?<><div className="modal-symbol"><CalendarDays size={22}/></div><div className="eyebrow">PROPOSED PROGRAMME</div><h2>Plenary Sitting No. 04</h2><p className="muted">Thursday, 12 November 2026 · 9:00 AM – 1:00 PM</p><Agenda/><p className="footnote">Illustrative agenda only. Confirm approved procedure and sitting details with the Assembly Secretariat.</p><button className="button button-primary full" onClick={onClose}>Close</button></>:<><div className="modal-symbol"><ShieldCheck size={22}/></div><div className="eyebrow">CHILD SAFEGUARDING</div><h2>Safety comes first</h2><ul className="safety-list"><li>Do not post phone numbers, home addresses, passwords or private documents.</li><li>Be respectful. Do not bully, threaten or identify another child without consent.</li><li>Do not share abuse disclosures in public forums. Use a restricted, trained safeguarding channel.</li><li>If someone is in immediate danger, contact a trusted adult or appropriate child-protection service.</li></ul><button className="button button-primary full" onClick={onClose}>I understand</button></>}</div></div>}
export default App;