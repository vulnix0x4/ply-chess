import './styles.css';
import { App } from './ui/app';

const root = document.getElementById('app')!;
const app = new App(root);
(window as unknown as { ply: App }).ply = app;
