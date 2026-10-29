import { render } from 'preact';
import { App } from './ui/App';
import { legacyAdminRedirect } from './ui/navigation';
import './styles.css';

const redirect = legacyAdminRedirect(window.location.hash);
if (redirect) {
  window.location.replace(redirect);
} else {
  render(<App />, document.getElementById('app')!);
}
