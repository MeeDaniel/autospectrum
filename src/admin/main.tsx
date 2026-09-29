import { render } from 'preact';
import { AdminApp } from './AdminApp';
import { renderAdminSection } from './sections';
import '../styles.css';
import './admin.css';
import './sections.css';

render(<AdminApp renderSection={renderAdminSection} />, document.getElementById('admin-app')!);
