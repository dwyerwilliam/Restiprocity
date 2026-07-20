import React from 'react';

interface ResponsePreviewErrorBoundaryProps {
  children: React.ReactNode;
}

interface ResponsePreviewErrorBoundaryState {
  failed: boolean;
}

export class ResponsePreviewErrorBoundary extends React.Component<ResponsePreviewErrorBoundaryProps, ResponsePreviewErrorBoundaryState> {
  state: ResponsePreviewErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): ResponsePreviewErrorBoundaryState {
    return { failed: true };
  }

  componentDidUpdate(previousProps: ResponsePreviewErrorBoundaryProps): void {
    if (previousProps.children !== this.props.children && this.state.failed) {
      this.setState({ failed: false });
    }
  }

  render(): React.ReactNode {
    if (this.state.failed) {
      return <div className="rounded border border-[var(--color-error)] bg-[var(--color-bg)] p-3 text-xs text-[var(--color-error)]">Unable to render this bounded response preview.</div>;
    }
    return this.props.children;
  }
}
