import { useState, useEffect, useCallback } from 'react';
import { studentService } from '../../services/student.service';
import { Card, Loader } from '../../components/common';

const DEBT_THRESHOLD = -120;

function fmtMin(minutes) {
  const abs  = Math.abs(minutes);
  const h    = Math.floor(abs / 60);
  const m    = abs % 60;
  const sign = minutes < 0 ? '−' : '+';
  if (h === 0) return `${sign}${m}min`;
  return `${sign}${h}h${m > 0 ? ` ${m}min` : ''}`;
}

function balanceStyle(balance) {
  if (balance >= 0)             return { text: 'text-emerald-600', bg: 'bg-emerald-50', border: 'border-emerald-200' };
  if (balance >= DEBT_THRESHOLD) return { text: 'text-amber-600',  bg: 'bg-amber-50',  border: 'border-amber-200'  };
  return                               { text: 'text-red-600',     bg: 'bg-red-50',    border: 'border-red-200'    };
}

const TASK_LABELS = {
  meeting:  '🤝 Reunión',
  review:   '📝 Revisión',
  guidance: '💡 Orientación',
  reply:    '📧 Respuesta',
  other:    '✨ Otro',
};

const BonusPage = () => {
  const [bonus, setBonus]   = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]   = useState(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await studentService.getMyBonus();
      setBonus(data);
    } catch (err) {
      setError('Error cargando datos de PrionBonus');
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) return <Loader fullScreen />;
  if (error)   return <div className="p-8 text-red-600">{error}</div>;

  const { earned, spent, balance, credits, allocations } = bonus;
  const style = balanceStyle(balance);

  // Merge transactions for timeline
  const transactions = [
    ...(credits || []).map((c) => ({
      type:       'credit',
      id:         c.id,
      date:       c.created_at,
      minutes:    c.minutes_earned,
      title:      c.article?.title ?? 'Artículo',
    })),
    ...(allocations || []).map((a) => ({
      type:       'allocation',
      id:         a.id,
      date:       a.created_at,
      minutes:    -a.minutes,
      task_type:  a.task_type,
      description: a.description,
    })),
  ].sort((a, b) => new Date(b.date) - new Date(a.date));

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl md:text-3xl font-bold text-gray-900">⚡ PrionBonus</h1>
        <p className="text-gray-600 mt-1">Tu saldo de tiempo de Jokin</p>
      </div>

      {/* Balance hero */}
      <div className={`rounded-xl border p-6 ${style.bg} ${style.border}`}>
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <p className="text-sm text-gray-500 mb-1">Balance actual</p>
            <p className={`text-5xl font-black ${style.text}`}>{fmtMin(balance)}</p>
            {balance < DEBT_THRESHOLD && (
              <p className="text-sm text-amber-700 mt-2 font-medium">
                ⚠️ Llevas más de 2h de deuda — ¡sigue leyendo para ponerte al día!
              </p>
            )}
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="text-center bg-white/70 rounded-lg p-3 border border-white">
              <p className="text-2xl font-bold text-emerald-600">{earned}min</p>
              <p className="text-xs text-gray-500">Ganado</p>
            </div>
            <div className="text-center bg-white/70 rounded-lg p-3 border border-white">
              <p className="text-2xl font-bold text-indigo-600">{spent}min</p>
              <p className="text-xs text-gray-500">Gastado</p>
            </div>
          </div>
        </div>
      </div>

      {/* Transaction history */}
      <Card title="Historial de transacciones">
        {transactions.length === 0 ? (
          <p className="text-center text-gray-400 py-8">
            Aún no tienes créditos. ¡Completa tu primer artículo para ganar tiempo!
          </p>
        ) : (
          <div className="space-y-3">
            {transactions.map((tx) => (
              <div
                key={tx.type + tx.id}
                className="flex items-center gap-4 p-4 border border-gray-100 rounded-lg hover:bg-gray-50 transition-colors"
              >
                {/* Icon */}
                <div className={`w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 text-lg ${
                  tx.type === 'credit' ? 'bg-emerald-100' : 'bg-indigo-100'
                }`}>
                  {tx.type === 'credit' ? '📄' : (TASK_LABELS[tx.task_type]?.split(' ')[0] ?? '✨')}
                </div>

                {/* Content */}
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-gray-900 text-sm truncate">
                    {tx.type === 'credit'
                      ? tx.title
                      : tx.description}
                  </p>
                  <p className="text-xs text-gray-400 mt-0.5">
                    {tx.type === 'credit'
                      ? 'Artículo completado'
                      : (TASK_LABELS[tx.task_type] ?? 'Asignación')}
                    {' · '}
                    {new Date(tx.date).toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' })}
                  </p>
                </div>

                {/* Minutes */}
                <div className={`font-bold text-sm flex-shrink-0 ${tx.minutes >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                  {fmtMin(tx.minutes)}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
};

export default BonusPage;
