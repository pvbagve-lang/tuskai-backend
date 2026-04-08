import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import api from '../lib/api'
import { useAuth } from '../context/AuthContext'

export default function Surveys() {
  const [surveys, setSurveys] = useState([])
  const [loading, setLoading] = useState(true)
  const nav = useNavigate()
  const { profile, creditsRemaining } = useAuth()

  useEffect(() => {
    api.get('/surveys').then(r => setSurveys(r.data.surveys||[])).catch(()=>{}).finally(()=>setLoading(false))
  }, [])

  const fmt = (d) => {
    if (!d) return '—'
    const dt = new Date(d)
    return dt.toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'}) + ' ' + dt.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'})
  }

  const C = { bg:'#0f1117', card:'#1a1d2e', border:'#2a2d3e', text:'#e2e8f0', muted:'#6b7280', accent:'#2563eb' }

  return (
    <div style={{minHeight:'100vh',background:C.bg,fontFamily:"'DM Sans',system-ui,sans-serif",color:C.text}}>
      <div style={{background:C.card,borderBottom:`1px solid ${C.border}`,padding:'0 24px',display:'flex',alignItems:'center',gap:'12px',height:'52px'}}>
        <span style={{fontSize:'17px',fontWeight:'800',color:'#fff',cursor:'pointer'}} onClick={()=>nav('/app')}>Tusk<span style={{color:C.accent}}>.AI</span></span>
        <div style={{fontSize:'10px',color:C.muted,fontFamily:'Consolas',marginLeft:'8px'}}>{profile?.plan?.toUpperCase()}</div>
        <div style={{flex:1}}/>
        <button style={{fontSize:'12px',color:C.muted,cursor:'pointer',background:'none',border:'none'}} onClick={()=>nav('/app')}>← Back to builder</button>
      </div>
      <div style={{maxWidth:'900px',margin:'0 auto',padding:'28px 20px'}}>
        <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:'24px'}}>
          <h1 style={{fontSize:'22px',fontWeight:'800',color:'#fff',margin:0}}>My Surveys</h1>
          <button onClick={()=>nav('/app')} style={{padding:'9px 18px',border:'none',borderRadius:'9px',background:'linear-gradient(135deg,#2563eb,#7c3aed)',color:'#fff',fontSize:'12px',fontWeight:'700',cursor:'pointer'}}>+ New Survey</button>
        </div>

        <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:'12px',marginBottom:'24px'}}>
          {[['Total',surveys.length,C.accent],['Drafts',surveys.filter(s=>s.status==='draft').length,'#d97706'],['Credits',creditsRemaining||0,'#059669']].map(([l,v,c])=>(
            <div key={l} style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:'12px',padding:'16px',textAlign:'center'}}>
              <div style={{fontSize:'24px',fontWeight:'800',color:c,fontFamily:'Consolas'}}>{v}</div>
              <div style={{fontSize:'10px',color:C.muted,textTransform:'uppercase',marginTop:'2px'}}>{l}</div>
            </div>
          ))}
        </div>

        {loading && <div style={{textAlign:'center',padding:'40px',color:C.muted,fontSize:'13px'}}>Loading surveys...</div>}

        {!loading && surveys.length === 0 && (
          <div style={{textAlign:'center',padding:'80px 20px',color:C.muted}}>
            <div style={{fontSize:'48px',marginBottom:'16px'}}>📋</div>
            <div style={{fontSize:'16px',fontWeight:'700',color:'#9ca3af',marginBottom:'8px'}}>No surveys yet</div>
            <div style={{fontSize:'12px',marginBottom:'24px'}}>Upload a questionnaire and generate your first survey</div>
            <button onClick={()=>nav('/app')} style={{padding:'9px 18px',border:'none',borderRadius:'9px',background:'linear-gradient(135deg,#2563eb,#7c3aed)',color:'#fff',fontSize:'12px',fontWeight:'700',cursor:'pointer'}}>Get started →</button>
          </div>
        )}

        {surveys.map(s => (
          <div key={s.id} style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:'14px',padding:'16px 20px',marginBottom:'10px',display:'flex',alignItems:'center',gap:'14px',cursor:'pointer',transition:'all .2s'}}
            onMouseOver={e=>{e.currentTarget.style.borderColor=C.accent;e.currentTarget.style.boxShadow='0 4px 20px rgba(37,99,235,.15)'}}
            onMouseOut={e=>{e.currentTarget.style.borderColor=C.border;e.currentTarget.style.boxShadow='none'}}
            onClick={()=>nav('/app')}>
            <div style={{width:'44px',height:'44px',borderRadius:'11px',background:'rgba(37,99,235,.1)',display:'flex',alignItems:'center',justifyContent:'center',fontSize:'20px',flexShrink:0}}>📋</div>
            <div style={{flex:1,minWidth:0}}>
              <div style={{fontSize:'14px',fontWeight:'700',color:'#fff',marginBottom:'4px'}}>{s.name||'Untitled Survey'}</div>
              <div style={{fontSize:'11px',color:C.muted,fontFamily:'Consolas'}}>
                {s.qualtrics_id ? `Qualtrics: ${s.qualtrics_id} · ` : ''}Created {fmt(s.created_at)}
              </div>
            </div>
            <div style={{fontSize:'9px',fontWeight:'700',padding:'3px 10px',borderRadius:'20px',background:s.status==='pushed'?'rgba(5,150,105,.15)':'rgba(107,114,128,.1)',color:s.status==='pushed'?'#059669':C.muted}}>{(s.status||'draft').toUpperCase()}</div>
          </div>
        ))}

        {surveys.length > 0 && <div style={{textAlign:'center',fontSize:'11px',color:'#374151',marginTop:'20px'}}>{surveys.length} survey{surveys.length!==1?'s':''}</div>}
      </div>
    </div>
  )
}
