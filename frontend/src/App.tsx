import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './lib/auth';
import Layout from './components/Layout';
import Login from './pages/Login';
import Documents from './pages/Documents';
import { ExecutionHistory, ReviewQueue } from './pages/ExecutionList';
import Agents from './pages/Agents';
import Tools from './pages/Tools';
import Prompts from './pages/Prompts';
import Schemas from './pages/Schemas';
import Workflows from './pages/Workflows';
import Logs from './pages/Logs';
import Settings from './pages/Settings';
import Extract from './pages/Extract';
import Jobs from './pages/Jobs';
import Forms from './pages/Forms';

const Dashboard = lazy(() => import('./pages/Dashboard'));
const ExecutionDetail = lazy(() => import('./pages/ExecutionDetail'));
const Lazy = ({ children }: { children: React.ReactNode }) => <Suspense fallback={<div className="page"><span className="spinner" /></div>}>{children}</Suspense>;

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
          <Route path="/" element={<PrivateRoute><Layout /></PrivateRoute>}>
            <Route index element={<Lazy><Dashboard /></Lazy>} />
            <Route path="documents" element={<Documents />} />
            <Route path="review" element={<ReviewQueue />} />
            <Route path="executions" element={<ExecutionHistory />} />
            <Route path="executions/:id" element={<Lazy><ExecutionDetail /></Lazy>} />
            <Route path="extractions" element={<Navigate to="/executions" replace />} />
            <Route path="agents" element={<Agents />} />
            <Route path="tools" element={<Tools />} />
            <Route path="prompts" element={<Prompts />} />
            <Route path="schemas" element={<Schemas />} />
            <Route path="workflows" element={<Workflows />} />
            <Route path="logs" element={<Logs />} />
            <Route path="tool-logs" element={<Navigate to="/logs" replace />} />
            <Route path="audit-logs" element={<Navigate to="/logs?tab=audit" replace />} />
            <Route path="settings" element={<Settings />} />
            <Route path="extract" element={<Extract />} />
            <Route path="jobs" element={<Jobs />} />
            <Route path="forms" element={<Forms />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
