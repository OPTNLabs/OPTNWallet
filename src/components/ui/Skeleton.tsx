import React from 'react';

type SkeletonProps = {
  width?: string;
  height?: string;
  className?: string;
};

const Skeleton: React.FC<SkeletonProps> = ({
  width = '100%',
  height = '1rem',
  className = '',
}) => {
  return (
    <div
      className={`bg-gray-300 animate-pulse rounded ${className}`}
      style={{ width, height }}
    />
  );
};

export default Skeleton;
