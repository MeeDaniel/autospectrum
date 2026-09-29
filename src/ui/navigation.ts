export type Route = 'form' | 'date-time' | 'review' | 'result';

export function routeFromHash(hash: string): Route {
  switch (hash.replace(/^#/, '')) {
    case '/date-time': return 'date-time';
    case '/review': return 'review';
    case '/result': return 'result';
    default: return 'form';
  }
}

export function shiftMonth(month: string, offset: number): string {
  const [year, index] = month.split('-').map(Number);
  const date = new Date(year, index - 1 + offset, 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

export function goTo(route: Route): void {
  window.location.hash = route === 'form' ? '#/' : `#/${route}`;
}
