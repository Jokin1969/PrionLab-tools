export const Modal = ({ isOpen, onClose, title, children, size = 'md' }) => {
  if (!isOpen) return null;

  const sizes = {
    sm: 'max-w-md',
    md: 'max-w-2xl',
    lg: 'max-w-4xl',
    xl: 'max-w-6xl',
  };

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto">
      <div className="flex items-start md:items-center justify-center min-h-screen px-3 pt-3 pb-3 md:px-4 md:pt-4 md:pb-20 text-center sm:p-0">

        {/* Overlay */}
        <div
          className="fixed inset-0 transition-opacity bg-gray-500 bg-opacity-75"
          onClick={onClose}
        />

        {/* Modal panel */}
        <div className={`relative inline-block w-full ${sizes[size]} overflow-hidden text-left align-middle transition-all transform bg-white rounded-lg shadow-xl`}>

          {/* Header */}
          <div className="px-4 py-3 md:px-6 md:py-4 border-b border-gray-200 flex items-center justify-between gap-2">
            <h3 className="text-base md:text-lg font-semibold text-gray-900">{title}</h3>
            <button
              onClick={onClose}
              className="flex-shrink-0 w-9 h-9 flex items-center justify-center rounded-full text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"
              aria-label="Cerrar"
            >
              ✕
            </button>
          </div>

          {/* Content */}
          <div className="px-4 py-4 md:px-6">
            {children}
          </div>

        </div>
      </div>
    </div>
  );
};
