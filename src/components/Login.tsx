import { useState } from 'react';
import { Eye, EyeOff, Scale } from 'lucide-react';
export function Login({ onLogin }: { onLogin: (user: string) => void }) {
  const [user,setUser]=useState(''); const [pass,setPass]=useState(''); const [visible,setVisible]=useState(false); const [error,setError]=useState('');
  const submit=()=>{ if ((user==='samer'&&pass==='samer.samer')||(user==='yacine'&&pass==='yacine.2001')) onLogin(user); else setError("Nom d'utilisateur ou mot de passe incorrect"); };
  return <div className="login-overlay"><div className="login-card"><div className="logo-icon login-logo"><Scale/></div><h2>JournalPro</h2><p className="center muted">Accès sécurisé</p>{error&&<p className="form-error">{error}</p>}<input className="form-input" placeholder="Nom d'utilisateur" value={user} onChange={e=>setUser(e.target.value)} onKeyDown={e=>e.key==='Enter'&&submit()}/><div className="password-wrap"><input className="form-input" type={visible?'text':'password'} placeholder="Mot de passe" value={pass} onChange={e=>setPass(e.target.value)} onKeyDown={e=>e.key==='Enter'&&submit()}/><button className="icon-button" onClick={()=>setVisible(!visible)}>{visible?<EyeOff/>:<Eye/>}</button></div><button className="btn btn-primary full" onClick={submit}>Se connecter</button></div></div>;
}
