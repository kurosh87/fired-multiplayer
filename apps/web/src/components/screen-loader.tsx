import { Component, Suspense, type ReactNode } from 'react';
import { Button } from './ui/button.tsx';
import { Card } from './ui/card.tsx';

/** Download failures must leave a usable page, including after a deploy while
 * an older tab is open. Reload fetches the current entry point and chunks. */
export class ScreenLoader extends Component<{ name: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() { return { failed: true }; }

  render() {
    if (this.state.failed) return <section className="screen-loading" aria-label={this.props.name}>
      <Card className="screen-loading-card">
        <h1>{this.props.name} could not open</h1>
        <p role="alert">Check your connection, then reload this page to try again.</p>
        <Button onClick={() => location.reload()}>Reload page</Button>
      </Card>
    </section>;
    return <Suspense fallback={<section className="screen-loading" aria-label={this.props.name} aria-busy="true">
      <Card className="screen-loading-card"><p role="status">Opening {this.props.name.toLowerCase()}…</p></Card>
    </section>}>{this.props.children}</Suspense>;
  }
}
