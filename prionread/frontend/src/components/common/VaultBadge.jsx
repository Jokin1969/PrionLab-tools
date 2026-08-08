import { useState } from 'react';
import api from '../../services/api';

const PRIONVAULT_BASE = 'https://web-production-5517e.up.railway.app/prionvault';

export function VaultBadge({ articleId, inPrionvault: initialIn, size = 'md' }) {
  const [inPv, setInPv] = useState(initialIn);
  const [loading, setLoading] = useState(false);

  const dim = size === 'sm' ? { btn: 'w-6 h-6', icon: 11 } : { btn: 'w-7 h-7', icon: 13 };

  const handleClick = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (inPv) {
      window.open(`${PRIONVAULT_BASE}?open=${articleId}`, '_blank', 'noopener');
      return;
    }
    setLoading(true);
    try {
      await api.post(`/articles/${articleId}/send-to-prionvault`);
      setInPv(true);
    } catch { /* silent */ }
    finally { setLoading(false); }
  };

  const color = inPv ? 'white' : '#9ca3af';
  return (
    <button
      onClick={handleClick}
      disabled={loading}
      title={inPv ? 'Ver en PrionVault ↗' : 'Enviar a PrionVault'}
      className={`flex items-center justify-center ${dim.btn} rounded-full transition-all hover:scale-110 disabled:opacity-50 shrink-0`}
      style={{ background: inPv ? '#0F3460' : '#e5e7eb' }}
    >
      <svg viewBox="0 0 16 16" width={dim.icon} height={dim.icon} fill="none">
        <circle cx="8" cy="8" r="6.5" stroke={color} strokeWidth="1.4"/>
        <circle cx="8" cy="8" r="3"   stroke={color} strokeWidth="1.1"/>
        <line x1="8" y1="1.5" x2="8" y2="14.5" stroke={color} strokeWidth="1.1"/>
        <line x1="1.5" y1="8" x2="14.5" y2="8" stroke={color} strokeWidth="1.1"/>
        <line x1="3.2" y1="3.2" x2="12.8" y2="12.8" stroke={color} strokeWidth="1.1"/>
        <line x1="12.8" y1="3.2" x2="3.2" y2="12.8" stroke={color} strokeWidth="1.1"/>
        <rect x="12.5" y="7.2" width="3" height="1.6" rx="0.8" fill={color}/>
      </svg>
    </button>
  );
}
