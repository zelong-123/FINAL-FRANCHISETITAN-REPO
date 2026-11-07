import React, { useEffect, useRef, useState } from 'react';
import {
  FaArrowLeft,
  FaBoxesStacked,
  FaBuilding,
  FaBullhorn,
  FaCheck,
  FaCheckDouble,
  FaCircle,
  FaCommentDots,
  FaComments,
  FaFaceSmile,
  FaHandshake,
  FaMagnifyingGlass,
  FaMinus,
  FaPaperPlane,
  FaStore,
  FaUser,
  FaUsers,
  FaUserShield,
  FaXmark,
} from 'react-icons/fa6';
import { useAuth } from '../../context/AuthContext';
import { useChat } from '../../context/ChatContext';

const QUICK_REACTIONS = ['👍', '❤️', '👏', '🎉', '🚀', '📦', '💡', '🔥'];

export function getDeptMeta(department, type = 'department') {
  if (type === 'direct') {
    return { icon: FaUser, className: '[background:rgba(99,_102,_241,_0.18)] text-[#818cf8] border border-[rgba(99,_102,_241,_0.3)]', label: 'Direct Message' };
  }
  switch (department) {
    case 'admin':
      return { icon: FaUserShield, className: '[background:rgba(168,_85,_247,_0.18)] text-[#c084fc] border border-[rgba(168,_85,_247,_0.3)]', label: 'Administration' };
    case 'marketing':
      return { icon: FaBullhorn, className: '[background:rgba(6,_182,_212,_0.18)] text-[#38bdf8] border border-[rgba(6,_182,_212,_0.3)]', label: 'Marketing' };
    case 'sales':
      return { icon: FaHandshake, className: '[background:rgba(34,_197,_94,_0.18)] text-[#4ade80] border border-[rgba(34,_197,_94,_0.3)]', label: 'Sales' };
    case 'logistics':
      return { icon: FaBoxesStacked, className: '[background:rgba(245,_158,_11,_0.18)] text-[#fbbf24] border border-[rgba(245,_158,_11,_0.3)]', label: 'Logistics' };
    case 'franchisee':
      return { icon: FaStore, className: '[background:rgba(59,_130,_246,_0.18)] text-[#60a5fa] border border-[rgba(59,_130,_246,_0.3)]', label: 'Franchisee' };
    default:
      return { icon: FaBuilding, className: '[background:rgba(99,_102,_241,_0.18)] text-[#818cf8] border border-[rgba(99,_102,_241,_0.3)]', label: 'All Departments' };
  }
}

export function formatMessageTime(isoString) {
  if (!isoString) return '';
  const date = new Date(isoString);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function formatDateGroup(isoString) {
  if (!isoString) return '';
  const date = new Date(isoString);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return 'Today';
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export function getInitials(name = 'User') {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join('') || 'U'
  );
}

export default function MessengerWidget() {
  const { user } = useAuth();

  const {
    channels,
    activeChannel,
    messages,
    unreadTotal,
    isOpen,
    isMinimized,
    sendingMessage,
    directory,
    setIsOpen,
    setIsMinimized,
    selectChannel,
    sendMessage,
    startDirectChat,
    toggleMessenger,
  } = useChat();

  const [activeTab, setActiveTab] = useState('chats'); // 'chats' | 'directory'
  const [inputText, setInputText] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [inThreadView, setInThreadView] = useState(false);
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);

  // Auto-scroll when messages update
  useEffect(() => {
    if (inThreadView && isOpen && !isMinimized) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, inThreadView, isOpen, isMinimized]);

  // Focus input when thread opens
  useEffect(() => {
    if (inThreadView && isOpen && !isMinimized) {
      const timer = window.setTimeout(() => inputRef.current?.focus(), 150);
      return () => window.clearTimeout(timer);
    }
  }, [inThreadView, isOpen, isMinimized, activeChannel?.id]);

  const handleSend = async (e) => {
    e?.preventDefault();
    if (!inputText.trim() || sendingMessage) return;
    const text = inputText;
    setInputText('');
    try {
      await sendMessage(text);
    } catch {
      setInputText(text);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  };

  const handleAddReaction = (emoji) => {
    setInputText((prev) => (prev ? `${prev} ${emoji}` : emoji));
    inputRef.current?.focus();
  };

  const handleOpenChannel = (chanId) => {
    selectChannel(chanId);
    setInThreadView(true);
  };

  const handleStartDirect = async (recipientId) => {
    await startDirectChat(recipientId);
    setInThreadView(true);
  };

  // Filter channels
  const filteredChannels = channels.filter((c) =>
    c.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    (c.department && c.department.toLowerCase().includes(searchQuery.toLowerCase()))
  );

  // Filter directory
  const filteredDirectory = directory.filter((u) =>
    u.full_name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    (u.department && u.department.toLowerCase().includes(searchQuery.toLowerCase())) ||
    u.email.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <>
      {/* Floating Messenger Launcher Button */}
   

      {/* Floating Messenger Window */}
      {isOpen && (
        <aside
          className={`fixed bottom-[96px] right-[28px] w-[410px] h-[600px] max-w-[calc(100vw_-_36px)] max-h-[calc(100vh_-_120px)] [background:var(--panel)] border border-line-strong rounded-[20px] [box-shadow:var(--shadow-xl),_0_20px_40px_rgba(0,_0,_0,_0.35)] flex flex-col overflow-hidden z-9999 [animation:messenger-pop-in_0.25s_cubic-bezier(0.16,_1,_0.3,_1)] [&.minimized]:h-auto [&.minimized]:rounded-[16px] ${isMinimized ? ' minimized' : ''}`}
          aria-label="Team Live Messenger"
        >
          {/* Header */}
          <div className="p-[12px_16px] [background:var(--panel-2)] border-b border-b-line flex items-center justify-between gap-3 [user-select:none]">
            <div className="flex items-center gap-[10px] min-w-0">
              {inThreadView ? (
                <>
                  <button
                    type="button"
                    className="[background:transparent] border-0 text-text-secondary text-[16px] cursor-pointer p-1 rounded-[6px] flex items-center justify-center [transition:background_0.15s_ease,_color_0.15s_ease] hover:[background:var(--surface-strong)] hover:text-text"
                    onClick={() => setInThreadView(false)}
                    title="Back to conversations"
                  >
                    <FaArrowLeft />
                  </button>
                  <div className={`messenger-avatar w-[38px] h-[38px] rounded-[50%] [background:linear-gradient(135deg,_var(--accent)_0%,_#6366f1_100%)] text-[#fff] flex items-center justify-center font-[700] text-[14px] relative shrink-[0] [box-shadow:0_2px_6px_rgba(0,_0,_0,_0.2)] ${activeChannel?.is_online ? "[&.messenger-avatar::after]:[content:''] [&.messenger-avatar::after]:absolute [&.messenger-avatar::after]:bottom-0 [&.messenger-avatar::after]:right-0 [&.messenger-avatar::after]:w-[11px] [&.messenger-avatar::after]:h-[11px] [&.messenger-avatar::after]:[background:#22c55e] [&.messenger-avatar::after]:rounded-[50%] [&.messenger-avatar::after]:border-[2px] [&.messenger-avatar::after]:border-panel" : ''}`}>
                    {getInitials(activeChannel?.name)}
                  </div>
                  <div className="min-w-0">
                    <div className="text-[14px] font-[700] text-text whitespace-nowrap overflow-hidden text-ellipsis flex items-center gap-[6px]">
                      {activeChannel?.name || 'Department Chat'}
                    </div>
                    <div className="inline-flex items-center gap-[5px] text-[11px] font-[500] text-[#22c55e]">
                      <span className="w-[7px] h-[7px] [background:#22c55e] rounded-[50%] [box-shadow:0_0_8px_rgba(34,_197,_94,_0.7)] [animation:pulse-ring_1.8s_infinite]" />
                      {activeChannel?.type === 'direct'
                        ? (activeChannel?.is_online ? 'Active now' : 'Colleague')
                        : 'Real-time Live'}
                    </div>
                  </div>
                </>
              ) : (
                <>
                  <div className="messenger-avatar w-[38px] h-[38px] rounded-[50%] [background:linear-gradient(135deg,_var(--accent)_0%,_#6366f1_100%)] text-[#fff] flex items-center justify-center font-[700] text-[14px] relative shrink-[0] [box-shadow:0_2px_6px_rgba(0,_0,_0,_0.2)]">
                    <FaComments />
                  </div>
                  <div className="min-w-0">
                    <div className="text-[14px] font-[700] text-text whitespace-nowrap overflow-hidden text-ellipsis flex items-center gap-[6px]">Franchise Messenger</div>
                    <div className="inline-flex items-center gap-[5px] text-[11px] font-[500] text-[#22c55e]">
                      <span className="w-[7px] h-[7px] [background:#22c55e] rounded-[50%] [box-shadow:0_0_8px_rgba(34,_197,_94,_0.7)] [animation:pulse-ring_1.8s_infinite]" />
                      Live Network Connected
                    </div>
                  </div>
                </>
              )}
            </div>

            <div className="flex items-center gap-[6px]">
              <button
                type="button"
                className="[background:transparent] border-0 text-muted w-[28px] h-[28px] rounded-[6px] flex items-center justify-center cursor-pointer text-[13px] [transition:all_0.15s_ease] hover:[background:var(--surface-strong)] hover:text-text"
                onClick={() => setIsMinimized((prev) => !prev)}
                title={isMinimized ? 'Restore' : 'Minimize'}
              >
                <FaMinus />
              </button>
              <button
                type="button"
                className="[background:transparent] border-0 text-muted w-[28px] h-[28px] rounded-[6px] flex items-center justify-center cursor-pointer text-[13px] [transition:all_0.15s_ease] hover:[background:var(--surface-strong)] hover:text-text"
                onClick={() => setIsOpen(false)}
                title="Close Messenger"
              >
                <FaXmark />
              </button>
            </div>
          </div>

          {!isMinimized && (
            <>
              {inThreadView ? (
                /* Thread Message View */
                <div className="flex-1 flex flex-col overflow-hidden">
                  <div className="flex-1 overflow-y-auto p-[14px_16px] flex flex-col gap-[10px]">
                    {messages.length === 0 ? (
                      <div style={{ textAlign: 'center', color: 'var(--muted)', margin: 'auto', padding: '24px' }}>
                        <FaComments style={{ fontSize: '32px', marginBottom: '8px', opacity: 0.5 }} />
                        <p style={{ margin: 0, fontSize: '13px' }}>No messages in this channel yet.</p>
                        <p style={{ margin: '4px 0 0', fontSize: '11px' }}>Be the first to say hello!</p>
                      </div>
                    ) : (
                      messages.map((msg, index) => {
                        const isMe = msg.user_id === user?.id;
                        const prevMsg = messages[index - 1];
                        const showDate =
                          !prevMsg ||
                          new Date(msg.created_at).toDateString() !==
                            new Date(prevMsg.created_at).toDateString();

                        return (
                          <React.Fragment key={msg.id || index}>
                            {showDate && (
                              <div className="flex items-center justify-center m-[10px_0_6px] [&_span]:[background:var(--surface-strong)] [&_span]:text-muted [&_span]:text-[10px] [&_span]:font-[600] [&_span]:p-[3px_10px] [&_span]:rounded-[12px] [&_span]:tracking-[0.04em] [&_span]:uppercase">
                                <span>{formatDateGroup(msg.created_at)}</span>
                              </div>
                            )}
                            <div className={`flex gap-2 max-w-[84%] items-end [&.sent-me]:self-end [&.sent-me]:flex-row-reverse later:[&.sent-them]:self-start ${isMe ? 'sent-me' : 'sent-them'}`}>
                              {!isMe && (
                                <div className="w-[28px] h-[28px] rounded-[50%] [background:var(--panel-3)] text-text text-[11px] font-[700] flex items-center justify-center shrink-[0] mb-[2px] border border-line">
                                  {getInitials(msg.user?.full_name)}
                                </div>
                              )}
                              <div className="flex flex-col">
                                {!isMe && (
                                  <div className="text-[11px] text-muted mb-[2px] flex items-center gap-[5px]">
                                    <span>{msg.user?.full_name || 'Team Member'}</span>
                                    {msg.user?.role?.label && (
                                      <span className="text-[9px] p-[1px_5px] rounded-[4px] [background:var(--surface-strong)] text-text-secondary font-[500]">
                                        {msg.user.role.label}
                                      </span>
                                    )}
                                  </div>
                                )}
                                <div className="p-[9px_14px] rounded-[16px] text-[13px] leading-[1.45] [word-break:break-word] relative [.sent-me_&]:[background:linear-gradient(135deg,_var(--accent)_0%,_#4f46e5_100%)] [.sent-me_&]:text-[#fff] [.sent-me_&]:[border-bottom-right-radius:4px] [.sent-me_&]:[box-shadow:0_4px_12px_rgba(79,_70,_229,_0.25)] later:[.sent-them_&]:[background:var(--panel-2)] [.sent-them_&]:border [.sent-them_&]:border-line later:[.sent-them_&]:text-text later:[.sent-them_&]:[border-bottom-left-radius:4px]">
                                  {msg.message}
                                  <div className="flex items-center justify-end gap-1 text-[10px] mt-[3px] opacity-[0.75] [.sent-me_&]:text-[rgba(255,_255,_255,_0.85)] later:[.sent-them_&]:text-muted">
                                    <span>{formatMessageTime(msg.created_at)}</span>
                                    {isMe && (
                                      msg._optimistic ? (
                                        <span style={{ opacity: 0.6 }}>•</span>
                                      ) : (
                                        <FaCheckDouble style={{ fontSize: '9px' }} />
                                      )
                                    )}
                                  </div>
                                </div>
                              </div>
                            </div>
                          </React.Fragment>
                        );
                      })
                    )}
                    <div ref={messagesEndRef} />
                  </div>

                  {/* Quick Reactions */}
                  <div className="flex items-center gap-[6px] p-[6px_14px_4px] overflow-x-auto border-t border-t-line [background:var(--panel-2)]">
                    {QUICK_REACTIONS.map((emoji) => (
                      <button
                        key={emoji}
                        type="button"
                        className="[background:transparent] border-0 text-[16px] cursor-pointer p-[3px_5px] rounded-[6px] [transition:transform_0.15s_ease,_background_0.15s_ease] hover:[transform:scale(1.3)] hover:[background:var(--surface-strong)]"
                        onClick={() => handleAddReaction(emoji)}
                        title={`Add ${emoji}`}
                      >
                        {emoji}
                      </button>
                    ))}
                  </div>

                  {/* Composer */}
                  <form className="p-[8px_14px_12px] [background:var(--panel-2)] border-t border-t-line flex items-center gap-2" onSubmit={handleSend}>
                    <input
                      ref={inputRef}
                      type="text"
                      className="flex-1 [background:var(--input-bg)] border border-input-line rounded-[20px] p-[9px_16px] text-[13px] text-text later:[outline:none] [resize:none] max-h-[90px] [transition:border-color_0.15s_ease] later:[font-family:inherit] focus:border-accent"
                      placeholder={`Message ${activeChannel?.name || 'team'}…`}
                      value={inputText}
                      onChange={(e) => setInputText(e.target.value)}
                      onKeyDown={handleKeyDown}
                      disabled={sendingMessage}
                    />
                    <button
                      type="submit"
                      className="w-[36px] h-[36px] rounded-[50%] [background:var(--accent)] text-[#fff] border-0 cursor-pointer flex items-center justify-center text-[14px] shrink-[0] [transition:all_0.15s_ease] [box-shadow:0_4px_10px_rgba(99,_102,_241,_0.3)] [&:hover:not(:disabled)]:[transform:scale(1.08)] [&:hover:not(:disabled)]:[background:#4f46e5] disabled:opacity-[0.4] disabled:cursor-not-allowed"
                      disabled={!inputText.trim() || sendingMessage}
                      title="Send Message"
                    >
                      <FaPaperPlane />
                    </button>
                  </form>
                </div>
              ) : (
                /* List View (Tabs: Channels vs Directory) */
                <div className="flex-1 overflow-y-auto p-[8px_0] flex flex-col">
                  <div className="flex [background:var(--panel-2)] border-b border-b-line p-[4px_12px_6px] gap-[6px]">
                    <button
                      type="button"
                      className={`messenger-tab flex-1 [background:transparent] border-0 p-[6px_12px] text-[12px] font-[600] text-muted rounded-[8px] cursor-pointer flex items-center justify-center gap-[6px] [transition:all_0.15s_ease] hover:text-text hover:[background:var(--surface-subtle)] later:[&.active]:[background:var(--surface-strong)] [&.active]:text-text [&.active]:font-[700] ${activeTab === 'chats' ? ' active [&.branch-selector-card]:border-[color:color-mix(in_srgb,_var(--accent)_46%,_var(--border))] [&.branch-selector-card]:[background:linear-gradient(145deg,_color-mix(in_srgb,_var(--accent)_7%,_var(--panel)),_var(--panel))] [&.branch-selector-card]:[box-shadow:0_0_0_3px_color-mix(in_srgb,_var(--accent)_8%,_transparent),_var(--shadow-md)] [&.duration-preset]:text-accent-text [&.duration-preset]:border-[color:color-mix(in_srgb,_var(--accent)_42%,_transparent)] [&.duration-preset]:[background:var(--active)] [&.inventory-chip]:text-[#fff] [&.inventory-chip]:border-transparent [&.inventory-chip]:[background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [&.inventory-chip]:[box-shadow:0_8px_18px_color-mix(in_srgb,_var(--accent)_26%,_transparent)] [.ap-tabs_&.ap-tab]:[background:rgba(123,_136,_255,_.18)] [.ap-tabs_&.ap-tab]:text-[#aeb6ff] [.ap-tabs_&.ap-tab]:border-transparent [.ap-tabs_&.ap-tab]:[box-shadow:none]' : ''}`}
                      onClick={() => setActiveTab('chats')}
                    >
                      <FaComments /> Departments & Chats
                      {unreadTotal > 0 && <span className="[.messenger-tab_&]:[background:#ef4444] [.messenger-tab_&]:text-[#fff] [.messenger-tab_&]:text-[10px] [.messenger-tab_&]:p-[1px_5px] [.messenger-tab_&]:rounded-[8px]">{unreadTotal}</span>}
                    </button>
                    <button
                      type="button"
                      className={`messenger-tab flex-1 [background:transparent] border-0 p-[6px_12px] text-[12px] font-[600] text-muted rounded-[8px] cursor-pointer flex items-center justify-center gap-[6px] [transition:all_0.15s_ease] hover:text-text hover:[background:var(--surface-subtle)] later:[&.active]:[background:var(--surface-strong)] [&.active]:text-text [&.active]:font-[700] ${activeTab === 'directory' ? ' active [&.branch-selector-card]:border-[color:color-mix(in_srgb,_var(--accent)_46%,_var(--border))] [&.branch-selector-card]:[background:linear-gradient(145deg,_color-mix(in_srgb,_var(--accent)_7%,_var(--panel)),_var(--panel))] [&.branch-selector-card]:[box-shadow:0_0_0_3px_color-mix(in_srgb,_var(--accent)_8%,_transparent),_var(--shadow-md)] [&.duration-preset]:text-accent-text [&.duration-preset]:border-[color:color-mix(in_srgb,_var(--accent)_42%,_transparent)] [&.duration-preset]:[background:var(--active)] [&.inventory-chip]:text-[#fff] [&.inventory-chip]:border-transparent [&.inventory-chip]:[background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [&.inventory-chip]:[box-shadow:0_8px_18px_color-mix(in_srgb,_var(--accent)_26%,_transparent)] [.ap-tabs_&.ap-tab]:[background:rgba(123,_136,_255,_.18)] [.ap-tabs_&.ap-tab]:text-[#aeb6ff] [.ap-tabs_&.ap-tab]:border-transparent [.ap-tabs_&.ap-tab]:[box-shadow:none]' : ''}`}
                      onClick={() => setActiveTab('directory')}
                    >
                      <FaUsers /> Team Directory
                    </button>
                  </div>

                  <div className="p-[4px_14px_10px]">
                    <input
                      type="text"
                      className="w-full p-[8px_12px] [background:var(--input-bg)] border border-input-line rounded-[10px] text-text text-[12px] later:[outline:none] [transition:border-color_0.15s_ease] focus:border-accent"
                      placeholder={
                        activeTab === 'chats'
                          ? 'Search department channels…'
                          : 'Search staff by name or role…'
                      }
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                    />
                  </div>

                  {activeTab === 'chats' ? (
                    <div>
                      <div className="p-[8px_16px_4px] text-[11px] font-[700] uppercase tracking-[0.05em] text-muted">Department Channels</div>
                      {filteredChannels
                        .filter((c) => c.type === 'department')
                        .map((chan) => {
                          const meta = getDeptMeta(chan.department, 'department');
                          const Icon = meta.icon;
                          const hasUnread = (chan.unread_count || 0) > 0;

                          return (
                            <button
                              key={chan.id}
                              type="button"
                              className="flex items-center gap-3 p-[10px_16px] cursor-pointer [transition:background_0.15s_ease] border-0 [background:transparent] w-full text-left hover:[background:var(--surface-subtle)] later:[&.active]:[background:var(--active)]"
                              onClick={() => handleOpenChannel(chan.id)}
                            >
                              <div className={`w-[38px] h-[38px] rounded-[12px] flex items-center justify-center text-[16px] shrink-[0] ${meta.className}`}>
                                <Icon />
                              </div>
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center justify-between gap-2">
                                  <span className="text-[13px] font-[600] text-text whitespace-nowrap overflow-hidden text-ellipsis">{chan.name}</span>
                                  {chan.last_message && (
                                    <span className="text-[10px] text-muted shrink-[0]">
                                      {formatMessageTime(chan.last_message.created_at)}
                                    </span>
                                  )}
                                </div>
                                <div className="text-[12px] text-text-secondary whitespace-nowrap overflow-hidden text-ellipsis mt-[2px]">
                                  {chan.last_message
                                    ? `${chan.last_message.user?.full_name?.split(' ')[0] || 'User'}: ${chan.last_message.message}`
                                    : chan.description || 'Live department room'}
                                </div>
                              </div>
                              {hasUnread && (
                                <span className="[background:var(--accent)] text-[#fff] text-[10px] font-[700] p-[1px_6px] rounded-[10px] shrink-[0]">{chan.unread_count}</span>
                              )}
                            </button>
                          );
                        })}

                      {/* Direct Messages Section */}
                      {filteredChannels.some((c) => c.type === 'direct') && (
                        <>
                          <div className="p-[8px_16px_4px] text-[11px] font-[700] uppercase tracking-[0.05em] text-muted" style={{ marginTop: '12px' }}>
                            Direct Messages
                          </div>
                          {filteredChannels
                            .filter((c) => c.type === 'direct')
                            .map((chan) => (
                              <button
                                key={chan.id}
                                type="button"
                                className="flex items-center gap-3 p-[10px_16px] cursor-pointer [transition:background_0.15s_ease] border-0 [background:transparent] w-full text-left hover:[background:var(--surface-subtle)] later:[&.active]:[background:var(--active)]"
                                onClick={() => handleOpenChannel(chan.id)}
                              >
                                <div className={`messenger-avatar w-[38px] h-[38px] rounded-[50%] [background:linear-gradient(135deg,_var(--accent)_0%,_#6366f1_100%)] text-[#fff] flex items-center justify-center font-[700] text-[14px] relative shrink-[0] [box-shadow:0_2px_6px_rgba(0,_0,_0,_0.2)] ${chan.is_online ? "[&.messenger-avatar::after]:[content:''] [&.messenger-avatar::after]:absolute [&.messenger-avatar::after]:bottom-0 [&.messenger-avatar::after]:right-0 [&.messenger-avatar::after]:w-[11px] [&.messenger-avatar::after]:h-[11px] [&.messenger-avatar::after]:[background:#22c55e] [&.messenger-avatar::after]:rounded-[50%] [&.messenger-avatar::after]:border-[2px] [&.messenger-avatar::after]:border-panel" : ''}`}>
                                  {getInitials(chan.name)}
                                </div>
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center justify-between gap-2">
                                    <span className="text-[13px] font-[600] text-text whitespace-nowrap overflow-hidden text-ellipsis">{chan.name}</span>
                                    {chan.last_message && (
                                      <span className="text-[10px] text-muted shrink-[0]">
                                        {formatMessageTime(chan.last_message.created_at)}
                                      </span>
                                    )}
                                  </div>
                                  <div className="text-[12px] text-text-secondary whitespace-nowrap overflow-hidden text-ellipsis mt-[2px]">
                                    {chan.last_message ? chan.last_message.message : 'Direct conversation'}
                                  </div>
                                </div>
                                {chan.unread_count > 0 && (
                                  <span className="[background:var(--accent)] text-[#fff] text-[10px] font-[700] p-[1px_6px] rounded-[10px] shrink-[0]">{chan.unread_count}</span>
                                )}
                              </button>
                            ))}
                        </>
                      )}
                    </div>
                  ) : (
                    /* Directory Tab */
                    <div>
                      <div className="p-[8px_16px_4px] text-[11px] font-[700] uppercase tracking-[0.05em] text-muted">All Team Members</div>
                      {filteredDirectory.map((colleague) => (
                        <div key={colleague.id} className="flex items-center justify-between gap-[10px] p-[10px_16px] [transition:background_0.15s_ease] hover:[background:var(--surface-subtle)]">
                          <div className="flex items-center gap-3 min-w-0">
                            <div className={`messenger-avatar w-[38px] h-[38px] rounded-[50%] [background:linear-gradient(135deg,_var(--accent)_0%,_#6366f1_100%)] text-[#fff] flex items-center justify-center font-[700] text-[14px] relative shrink-[0] [box-shadow:0_2px_6px_rgba(0,_0,_0,_0.2)] ${colleague.is_online ? "[&.messenger-avatar::after]:[content:''] [&.messenger-avatar::after]:absolute [&.messenger-avatar::after]:bottom-0 [&.messenger-avatar::after]:right-0 [&.messenger-avatar::after]:w-[11px] [&.messenger-avatar::after]:h-[11px] [&.messenger-avatar::after]:[background:#22c55e] [&.messenger-avatar::after]:rounded-[50%] [&.messenger-avatar::after]:border-[2px] [&.messenger-avatar::after]:border-panel" : ''}`}>
                              {getInitials(colleague.full_name)}
                            </div>
                            <div style={{ minWidth: 0 }}>
                              <div className="text-[13px] font-[600] text-text whitespace-nowrap overflow-hidden text-ellipsis">{colleague.full_name}</div>
                              <div className="text-[11px] text-muted">
                                {colleague.role_label || colleague.department}
                                {colleague.is_online && (
                                  <span style={{ color: '#22c55e', marginLeft: '6px' }}>• Active</span>
                                )}
                              </div>
                            </div>
                          </div>
                          <button
                            type="button"
                            className="[background:var(--surface-strong)] border border-line text-accent-text p-[5px_12px] rounded-[8px] text-[11px] font-[600] cursor-pointer [transition:all_0.15s_ease] whitespace-nowrap hover:[background:var(--accent)] later-5:hover:text-[#fff] hover:border-accent"
                            onClick={() => handleStartDirect(colleague.id)}
                          >
                            Message
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </aside>
      )}
    </>
  );
}
