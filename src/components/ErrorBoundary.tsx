// src/components/ErrorBoundary.tsx

import React from 'react';
import { I18nContext } from '../i18n/I18nContext';

interface ErrorBoundaryProps {
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

class ErrorBoundary extends React.Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  static contextType = I18nContext;
  declare context: React.ContextType<typeof I18nContext>;
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    // Update state so the next render shows the fallback UI.
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    // You can also log the error to an error reporting service
    console.error('Error Boundary Caught an Error:', error, errorInfo);
  }

  render() {
    if (this.state.hasError && this.state.error) {
      // Render fallback UI
      return (
        <div className="flex flex-col items-center justify-center h-screen wallet-surface">
          <h1 className="text-2xl font-bold mb-4 wallet-text-strong">
            {this.context?.t('error.somethingWrong') ?? 'Something went wrong.'}
          </h1>
          <p className="wallet-muted">{this.state.error.message}</p>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
