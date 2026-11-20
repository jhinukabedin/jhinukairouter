import { useEffect, useState } from 'react';
import { getToken } from './lib/api';
import Login from './pages/Login';
import Register from './pages/Register';
import Overview from './pages/Overview';
import Providers from './pages/Providers';
import Models from './pages/Models';
import ApiKeys from './pages/ApiKeys';
import RoutingProfiles from './pages/RoutingProfiles';
import Usage from './pages/Usage';
import Credits from './pages/Credits';
import RequestLogs from './pages/RequestLogs';
import ClientSetup from './pages/ClientSetup';
import Settings from './pages/Settings';
import Admin from './pages/Admin';

function route(): string {
  return window.location.hash.replace(/^#\/?/, '').split('?')[0] || '';
}

export default function App() {
  const [hash, setHash] = useState(route());
  useEffect(() => {
    const onChange = () => setHash(route());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  const authed = !!getToken();
  if (!authed) {
    return hash === 'register' ? <Register /> : <Login />;
  }

  switch (hash) {
    case '': return <Overview />;
    case 'providers': return <Providers />;
    case 'models': return <Models />;
    case 'api-keys': return <ApiKeys />;
    case 'routing': return <RoutingProfiles />;
    case 'usage': return <Usage />;
    case 'credits': return <Credits />;
    case 'logs': return <RequestLogs />;
    case 'client-setup': return <ClientSetup />;
    case 'settings': return <Settings />;
    case 'admin': return <Admin />;
    case 'login':
    case 'register':
      window.location.hash = '#/';
      return <Overview />;
    default:
      return <Overview />;
  }
}
