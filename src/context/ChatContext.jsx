import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react';
import { api } from '../lib/api';
import { useAuth } from './AuthContext';

const ChatContext = createContext(null);

export function playMessengerChime() {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = 'sine';
    const now = ctx.currentTime;
    osc.frequency.setValueAtTime(587.33, now); // D5
    osc.frequency.exponentialRampToValueAtTime(880, now + 0.09); // A5
    gain.gain.setValueAtTime(0.15, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.28);
    osc.start(now);
    osc.stop(now + 0.28);
  } catch {
    // Autoplay restrictions or unsupported audio
  }
}

export function ChatProvider({ children }) {
  const { isAuthenticated, user } = useAuth();
  const [channels, setChannels] = useState([]);
  const [activeChannelId, setActiveChannelId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [unreadTotal, setUnreadTotal] = useState(0);
  const [onlineCount, setOnlineCount] = useState(1);
  const [directory, setDirectory] = useState([]);
  const [isOpen, setIsOpen] = useState(false);
  const [isMinimized, setIsMinimized] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [sendingMessage, setSendingMessage] = useState(false);

  const isOpenRef = useRef(isOpen);
  isOpenRef.current = isOpen;

  const isMinimizedRef = useRef(isMinimized);
  isMinimizedRef.current = isMinimized;

  const activeChannelRef = useRef(activeChannelId);
  activeChannelRef.current = activeChannelId;

  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  const lastMessageIdRef = useRef(0);

  // Load all channels
  const loadChannels = useCallback(async (silent = false) => {
    if (!isAuthenticated) return;
    try {
      const response = await api.get('/chat/channels');
      const list = response.data || [];
      setChannels(list);

      const total = list.reduce((acc, c) => acc + (c.unread_count || 0), 0);
      setUnreadTotal(total);

      // No channel is opened automatically: fetching counts must not mark any
      // conversation seen before the user actually opens it.
    } catch {
      // Silent error handling for periodic background checks
    }
  }, [isAuthenticated]);

  // Load directory
  const loadDirectory = useCallback(async () => {
    if (!isAuthenticated) return;
    try {
      const response = await api.get('/chat/directory');
      setDirectory(response.data || []);
    } catch {
      // Ignore
    }
  }, [isAuthenticated]);

  // Load messages for a channel.
  // `markRead` is only true when the user is genuinely looking at the thread
  // (widget open, not minimized); otherwise the backend leaves unread counts alone.
  const loadMessages = useCallback(async (channelId, isInitial = false, markRead = false) => {
    if (!channelId || !isAuthenticated) return;
    if (!markRead && (!isOpenRef.current || isMinimizedRef.current)) {
      // Do not fetch while the messenger is closed or minimized: reading in the
      // background would silently mark conversations as seen.
      return;
    }
    if (isInitial) setLoadingMessages(true);
    try {
      const response = await api.get(`/chat/channels/${channelId}/messages`, markRead ? { mark_read: 1 } : { mark_read: 0 });
      const msgList = response.data?.messages || [];
      setMessages(msgList);
      if (msgList.length > 0) {
        lastMessageIdRef.current = msgList[msgList.length - 1].id;
      } else {
        lastMessageIdRef.current = 0;
      }
      if (markRead) {
        setChannels((prev) =>
          prev.map((c) => (c.id === channelId ? { ...c, unread_count: 0 } : c))
        );
      }
    } catch {
      // Ignore
    } finally {
      if (isInitial) setLoadingMessages(false);
    }
  }, [isAuthenticated]);

  // Incremental real-time poll for active channel messages — runs only while
  // the messenger window is open and not minimized, so background polling can
  // never mark conversations as seen.
  const pollActiveMessages = useCallback(async () => {
    const chanId = activeChannelRef.current;
    if (!chanId || !isAuthenticated) return;
    if (!isOpenRef.current || isMinimizedRef.current) return;
    const sinceId = lastMessageIdRef.current;
    if (!sinceId) return;

    try {
      const response = await api.get(`/chat/channels/${chanId}/messages`, { since_id: sinceId, mark_read: 1 });
      const newItems = response.data?.messages || [];
      if (newItems.length > 0) {
        setMessages((prev) => {
          const existingIds = new Set(prev.map((m) => m.id));
          const filtered = newItems.filter((m) => !existingIds.has(m.id));
          if (filtered.length === 0) return prev;

          // Check if any message is from another user to play chime
          const fromOther = filtered.some((m) => m.user_id !== user?.id);
          if (fromOther) {
            playMessengerChime();
          }

          return [...prev, ...filtered];
        });
        lastMessageIdRef.current = newItems[newItems.length - 1].id;

        // Update local channel list snippet
        const lastMsg = newItems[newItems.length - 1];
        setChannels((prev) =>
          prev.map((c) =>
            c.id === chanId
              ? { ...c, last_message: lastMsg, unread_count: 0 }
              : c
          )
        );
      }
    } catch {
      // Network interruption
    }
  }, [isAuthenticated, user?.id]);

  // Send message
  const sendMessage = async (text) => {
    const chanId = activeChannelRef.current;
    if (!chanId || !text?.trim() || !isAuthenticated) return;

    const trimmed = text.trim();
    const tempId = `temp_${Date.now()}`;
    const optimisticMsg = {
      id: tempId,
      channel_id: chanId,
      user_id: user?.id,
      message: trimmed,
      created_at: new Date().toISOString(),
      user: {
        id: user?.id,
        full_name: user?.full_name || 'Me',
        role: user?.role,
      },
      _optimistic: true,
    };

    setMessages((prev) => [...prev, optimisticMsg]);
    setSendingMessage(true);

    try {
      const response = await api.post(`/chat/channels/${chanId}/messages`, { message: trimmed });
      const created = response.data;
      setMessages((prev) =>
        prev.map((m) => (m.id === tempId ? created : m))
      );
      if (created.id > lastMessageIdRef.current) {
        lastMessageIdRef.current = created.id;
      }
      // Update channel list snippet
      setChannels((prev) =>
        prev.map((c) =>
          c.id === chanId
            ? { ...c, last_message: created, unread_count: 0 }
            : c
        )
      );
      return created;
    } catch (err) {
      setMessages((prev) => prev.filter((m) => m.id !== tempId));
      throw err;
    } finally {
      setSendingMessage(false);
    }
  };

  // Switch active channel
  const selectChannel = (channelId) => {
    setActiveChannelId(channelId);
    activeChannelRef.current = channelId;
    lastMessageIdRef.current = 0;
    void loadMessages(channelId, true);
  };

  // Start or open direct message
  const startDirectChat = async (recipientId) => {
    try {
      const response = await api.post('/chat/direct', { recipient_id: recipientId });
      const chanData = response.data;
      await loadChannels();
      selectChannel(chanData.id);
      setIsOpen(true);
      setIsMinimized(false);
      return chanData;
    } catch (err) {
      console.error('Failed to open direct chat', err);
    }
  };

  // Heartbeat & presence ping
  const sendHeartbeat = useCallback(async () => {
    if (!isAuthenticated) return;
    try {
      const response = await api.post('/chat/heartbeat');
      if (response.data) {
        setOnlineCount(response.data.online_count || 1);
        setUnreadTotal(response.data.total_unread || 0);
      }
    } catch {
      // Ignore
    }
  }, [isAuthenticated]);

  // Initial mount when authenticated
  useEffect(() => {
    if (!isAuthenticated) {
      setChannels([]);
      setMessages([]);
      setActiveChannelId(null);
      return;
    }

    void loadChannels();
    void loadDirectory();
    void sendHeartbeat();

    // Heartbeat every 25 seconds
    const heartbeatTimer = window.setInterval(sendHeartbeat, 25000);
    // Background channels refresh every 8 seconds
    const channelsTimer = window.setInterval(() => void loadChannels(true), 8000);

    return () => {
      window.clearInterval(heartbeatTimer);
      window.clearInterval(channelsTimer);
    };
  }, [isAuthenticated, loadChannels, loadDirectory, sendHeartbeat]);

  // When active channel changes, load initial messages
  useEffect(() => {
    if (activeChannelId) {
      void loadMessages(activeChannelId, true);
    }
  }, [activeChannelId, loadMessages]);

  // Real-time incremental polling: every 1.8 seconds when user is on the page
  useEffect(() => {
    if (!isAuthenticated || !activeChannelId) return;

    let timer;
    const runPoll = async () => {
      if (document.visibilityState === 'visible') {
        await pollActiveMessages();
      }
    };

    timer = window.setInterval(runPoll, 1800);
    return () => window.clearInterval(timer);
  }, [isAuthenticated, activeChannelId, pollActiveMessages]);

  const activeChannel = channels.find((c) => c.id === activeChannelId) || null;

  const value = {
    channels,
    activeChannel,
    activeChannelId,
    messages,
    unreadTotal,
    onlineCount,
    directory,
    isOpen,
    isMinimized,
    loadingMessages,
    sendingMessage,
    setIsOpen,
    setIsMinimized,
    selectChannel,
    sendMessage,
    startDirectChat,
    loadDirectory,
    loadChannels,
    toggleMessenger: () => {
      setIsOpen((prev) => !prev);
      setIsMinimized(false);
    },
    openMessenger: (targetChannelId) => {
      setIsOpen(true);
      setIsMinimized(false);
      if (targetChannelId) {
        selectChannel(targetChannelId);
      }
    },
    closeMessenger: () => {
      setIsOpen(false);
    },
  };

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}

export function useChat() {
  const ctx = useContext(ChatContext);
  if (!ctx) {
    throw new Error('useChat must be used within a ChatProvider');
  }
  return ctx;
}
