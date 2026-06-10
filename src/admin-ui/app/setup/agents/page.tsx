import { redirect } from 'next/navigation';

/** A gestão de agentes mudou para o hub /agents (redesign da UI). */
export default function LegacyAgentsSetupRedirect() {
  redirect('/agents');
}
