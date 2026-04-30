import { Link } from 'react-router-dom';
import { Shell } from '@/components/primitives/Shell';
import { buttonVariants } from '@/components/primitives/Button';

export function NotFound() {
  return (
    <Shell header={<span className="font-semibold tracking-tight-16">Townhouse</span>}>
      <div className="flex flex-col items-center justify-center gap-4 py-16">
        <p className="text-sm text-ink/60">Route not found.</p>
        <Link to="/" className={buttonVariants({ variant: 'secondary' })}>
          Back to Home
        </Link>
      </div>
    </Shell>
  );
}
