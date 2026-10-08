const variants = {
  default:   'bg-gray-100 text-gray-700',
  primary:   'bg-indigo-100 text-indigo-700',
  success:   'bg-green-100 text-green-700',
  warning:   'bg-amber-100 text-amber-700',
  danger:    'bg-red-100 text-red-700',
  milestone: 'bg-purple-100 text-purple-700',
};

// Maps UserArticle.status → badge variant
const statusVariant = {
  pending:    'default',
  read:       'primary',
  summarized: 'warning',
  evaluated:  'success',
};

export default function Badge({ children, variant = 'default', className = '' }) {
  return (
    <span className={`badge ${variants[variant] || variants.default} ${className}`}>
      {children}
    </span>
  );
}

export function StatusBadge({ status }) {
  const labels = {
    pending: 'Pendiente', read: 'Leído',
    summarized: 'Resumido', evaluated: 'Evaluado',
  };
  return <Badge variant={statusVariant[status] || 'default'}>{labels[status] || status}</Badge>;
}
