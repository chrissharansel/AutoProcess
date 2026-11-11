import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './lib/auth';
import Layout from './components/Layout';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Extract from './pages/Extract';
import Jobs from './pages/Jobs';
import Forms from './pages/Forms';
import Workflows from './pages/Workflows';
import AgentStudio from './pages/AgentStudio';

function PrivateRoute({ children }: { children: React.ReactNode }) {
  const { token, loading } = useAuth();
  if (loading) return <div className="loading-full">Loading…</div>;
  if (!token) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route
            path="/"
            element={
              <PrivateRoute>
                <Layout />
              </PrivateRoute>
            }
          >
            <Route index element={<Dashboard />} />
            <Route path="extract" element={<Extract />} />
            <Route path="jobs" element={<Jobs />} />
            <Route path="forms" element={<Forms />} />
            <Route path="workflows" element={<Workflows />} />
            <Route path="agents" element={<AgentStudio />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
