import { AlertTriangle, CircleSlash, Compass, Database, GitBranch, ListTree, Wrench } from 'lucide-react';
import type { ReactNode } from 'react';
import { Chip, type Tone } from './ui';

export interface AnalysisData {
  noSetup: boolean;
  dataReference: { timeframes: string[]; asOf: string; feed: string };
  marketStructure: { state: 'bullish' | 'bearish' | 'ranging' | 'unclear'; summary: string };
  levels: { price: number; kind: string; reason: string }[];
  scenarios: { condition: string; outcome: string }[];
  invalidation: string;
  missingInformation: string[];
  actionsTaken: string[];
}

const TONE: Record<string, Tone> = { bullish: 'ok', bearish: 'danger', ranging: 'neutral', unclear: 'warn' };

const Row = ({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) => (
  <div className="ac-row"><div className="ac-t">{icon}{title}</div><div className="ac-b">{children}</div></div>
);

/** Fixed analysis layout so every answer has the same fields, on desktop and later on WhatsApp. */
export function AnalysisCard({ a }: { a: AnalysisData }) {
  return (
    <article className="acard" aria-label="Analysis">
      <header className="ac-h">
        <strong>Analysis</strong>
        {a.noSetup ? <Chip tone="warn" icon={CircleSlash}>No setup</Chip> : <Chip tone="ai">Setup conditions</Chip>}
        <Chip tone={TONE[a.marketStructure.state]}>{a.marketStructure.state}</Chip>
      </header>
      <Row icon={<Database size={13} />} title="Data reference">
        <span className="mono">{a.dataReference.feed} · {a.dataReference.timeframes.join(' + ')} · as of {a.dataReference.asOf}</span>
      </Row>
      <Row icon={<Compass size={13} />} title="Market structure">{a.marketStructure.summary}</Row>
      {a.levels.length > 0 && (
        <Row icon={<ListTree size={13} />} title="Relevant levels">
          <ul className="ac-list">{a.levels.map((l, i) => (
            <li key={i}><span className="mono ac-price">{l.price.toFixed(2)}</span><Chip>{l.kind}</Chip><span>{l.reason}</span></li>
          ))}</ul>
        </Row>
      )}
      {a.scenarios.length > 0 && (
        <Row icon={<GitBranch size={13} />} title="Scenarios">
          <ul className="ac-list">{a.scenarios.map((s, i) => <li key={i}><strong>If</strong> {s.condition} <strong>then</strong> {s.outcome}</li>)}</ul>
        </Row>
      )}
      <Row icon={<AlertTriangle size={13} />} title="Invalidation">{a.invalidation}</Row>
      {a.missingInformation.length > 0 && <Row icon={<CircleSlash size={13} />} title="Missing information"><ul className="ac-list">{a.missingInformation.map((m, i) => <li key={i}>{m}</li>)}</ul></Row>}
      {a.actionsTaken.length > 0 && <Row icon={<Wrench size={13} />} title="Chart actions"><ul className="ac-list">{a.actionsTaken.map((m, i) => <li key={i}>{m}</li>)}</ul></Row>}
      <footer className="ac-f">Information, not financial advice. No outcome or win rate is implied.</footer>
    </article>
  );
}
