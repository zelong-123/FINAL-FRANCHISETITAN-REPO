import { useCallback, useEffect, useRef, useState } from 'react';
import { firstValidationMessage } from './api';

export default function useRemote(loader, dependencies = []) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const requestId = useRef(0);
  const mounted = useRef(true);

  useEffect(() => () => { mounted.current = false; }, []);

  const reload = useCallback(async (options = {}) => {
    const silent = Boolean(options?.silent);
    const currentRequest = ++requestId.current;
    if (mounted.current) {
      if (!silent) setLoading(true);
      setError('');
    }
    try {
      const result = await loader();
      if (mounted.current && currentRequest === requestId.current) setData(result);
      return result;
    } catch (requestError) {
      if (mounted.current && currentRequest === requestId.current) setError(firstValidationMessage(requestError));
      return null;
    } finally {
      if (mounted.current && currentRequest === requestId.current && !silent) setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, dependencies);

  useEffect(() => {
    mounted.current = true;
    void reload();
  }, [reload]);

  return { data, setData, loading, error, setError, reload };
}
