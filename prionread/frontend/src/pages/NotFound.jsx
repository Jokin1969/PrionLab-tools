import { Link } from 'react-router-dom';
import { RiFlaskLine } from 'react-icons/ri';

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-gray-50 px-4 text-center">
      <RiFlaskLine className="h-12 w-12 text-gray-300" />
      <h1 className="text-4xl font-bold text-gray-800">404</h1>
      <p className="text-gray-500">La página que buscas no existe</p>
      <Link to="/" className="btn-primary mt-2">
        Volver al inicio
      </Link>
    </div>
  );
}
