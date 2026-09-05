export const Card = ({ children, className = '', title, actions }) => {
  return (
    <div className={`bg-white rounded-lg shadow-md overflow-hidden ${className}`}>
      {title && (
        <div className="px-4 py-3 md:px-6 md:py-4 border-b border-gray-200 flex justify-between items-center">
          <h3 className="text-lg font-semibold text-gray-900">{title}</h3>
          {actions && <div className="flex gap-2">{actions}</div>}
        </div>
      )}
      <div className="p-4 md:p-6">
        {children}
      </div>
    </div>
  );
};
