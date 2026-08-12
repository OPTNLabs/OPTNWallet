import useSharedTokenMetadata from './useSharedTokenMetadata';

const useTokenMetadata = (categories: string[]) => {
  return useSharedTokenMetadata(categories);
};

export default useTokenMetadata;
