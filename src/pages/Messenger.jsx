import React, { useEffect, useRef, useState } from 'react';
import {
  FaArrowLeft,
  FaBoxesStacked,
  FaBuilding,
  FaBullhorn,
  FaCheckDouble,
  FaCircle,
  FaCommentDots,
  FaComments,
  FaHandshake,
  FaMagnifyingGlass,
  FaPaperPlane,
  FaStore,
  FaUser,
  FaUsers,
  FaUserShield,
} from 'react-icons/fa6';
import { useAuth } from '../context/AuthContext';
import { useChat } from '../context/ChatContext';
import {
  formatDateGroup,
  formatMessageTime,
  getDeptMeta,
  getInitials,
} from '../components/Messenger/MessengerWidget';

const QUICK_REACTIONS = ['👍', '❤️', '👏', '🎉', '🚀', '📦', '💡', '🔥'];

export default function Messenger() {
  const { user } = useAuth();
  const {
    channels,
    activeChannel,
    messages,
    sendingMessage,
    directory,
    selectChannel,
    sendMessage,
    startDirectChat,
    onlineCount,
  } = useChat();

  const [inputText, setInputText] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState('chats'); // 'chats' | 'directory'
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);

  // Auto-scroll when messages update
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Focus input when active channel changes
  useEffect(() => {
    inputRef.current?.focus();
  }, [activeChannel?.id]);

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

  const filteredChannels = channels.filter((c) =>
    c.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    (c.department && c.department.toLowerCase().includes(searchQuery.toLowerCase()))
  );

  const filteredDirectory = directory.filter((u) =>
    u.full_name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    (u.department && u.department.toLowerCase().includes(searchQuery.toLowerCase())) ||
    u.email.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const activeMeta = activeChannel
    ? getDeptMeta(activeChannel.department, activeChannel.type)
    : null;
  const ActiveIcon = activeMeta ? activeMeta.icon : FaComments;

  return (
    <div className="operations-page-wrap">
      {/* Page Header */}
      <div className="page-header-row" style={{ marginBottom: '16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginLeft: 'auto' }}>
          <div className="inline-flex items-center gap-[5px] text-[11px] font-[500] text-[#22c55e]" style={{ background: 'var(--surface-strong)', padding: '6px 14px', borderRadius: '20px' }}>
            <span className="w-[7px] h-[7px] [background:#22c55e] rounded-[50%] [box-shadow:0_0_8px_rgba(34,_197,_94,_0.7)] [animation:pulse-ring_1.8s_infinite]" />
            <span>Real-time Live • {onlineCount} active now</span>
          </div>
        </div>
      </div>

      {/* Main Full Messenger Container */}
      <div className="full-messenger-page grid grid-cols-[320px_1fr_280px] h-[calc(100vh_-_var(--header-height)_-_32px)] max-h-[860px] [background:var(--panel)] border border-line rounded-[16px] overflow-hidden [box-shadow:var(--shadow-md)] mb-6 max-[1201px]:later:grid-cols-[300px_1fr] max-[769px]:later:flex max-[769px]:flex-col max-[769px]:later:h-[calc(100vh_-_var(--header-height)_-_16px)]">
        {/* Left Column: Channels & Directory */}
        <aside className="border-r border-r-line flex flex-col [background:var(--panel-2)]">
          {/* Header tabs */}
          <div className="flex [background:var(--panel-2)] border-b border-b-line p-[4px_12px_6px] gap-[6px]" style={{ padding: '12px 14px' }}>
            <button
              type="button"
              className={`messenger-tab flex-1 [background:transparent] border-0 p-[6px_12px] text-[12px] font-[600] text-muted rounded-[8px] cursor-pointer flex items-center justify-center gap-[6px] [transition:all_0.15s_ease] hover:text-text hover:[background:var(--surface-subtle)] later:[&.active]:[background:var(--surface-strong)] [&.active]:text-text [&.active]:font-[700] ${activeTab === 'chats' ? ' active [&.branch-selector-card]:border-[color:color-mix(in_srgb,_var(--accent)_46%,_var(--border))] [&.branch-selector-card]:[background:linear-gradient(145deg,_color-mix(in_srgb,_var(--accent)_7%,_var(--panel)),_var(--panel))] [&.branch-selector-card]:[box-shadow:0_0_0_3px_color-mix(in_srgb,_var(--accent)_8%,_transparent),_var(--shadow-md)] [&.duration-preset]:text-accent-text [&.duration-preset]:border-[color:color-mix(in_srgb,_var(--accent)_42%,_transparent)] [&.duration-preset]:[background:var(--active)] [&.inventory-chip]:text-[#fff] [&.inventory-chip]:border-transparent [&.inventory-chip]:[background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [&.inventory-chip]:[box-shadow:0_8px_18px_color-mix(in_srgb,_var(--accent)_26%,_transparent)] [.ap-tabs_&.ap-tab]:[background:rgba(123,_136,_255,_.18)] [.ap-tabs_&.ap-tab]:text-[#aeb6ff] [.ap-tabs_&.ap-tab]:border-transparent [.ap-tabs_&.ap-tab]:[box-shadow:none]' : ''}`}
              onClick={() => setActiveTab('chats')}
            >
              <FaComments /> Channels
            </button>
            <button
              type="button"
              className={`messenger-tab flex-1 [background:transparent] border-0 p-[6px_12px] text-[12px] font-[600] text-muted rounded-[8px] cursor-pointer flex items-center justify-center gap-[6px] [transition:all_0.15s_ease] hover:text-text hover:[background:var(--surface-subtle)] later:[&.active]:[background:var(--surface-strong)] [&.active]:text-text [&.active]:font-[700] ${activeTab === 'directory' ? ' active [&.branch-selector-card]:border-[color:color-mix(in_srgb,_var(--accent)_46%,_var(--border))] [&.branch-selector-card]:[background:linear-gradient(145deg,_color-mix(in_srgb,_var(--accent)_7%,_var(--panel)),_var(--panel))] [&.branch-selector-card]:[box-shadow:0_0_0_3px_color-mix(in_srgb,_var(--accent)_8%,_transparent),_var(--shadow-md)] [&.duration-preset]:text-accent-text [&.duration-preset]:border-[color:color-mix(in_srgb,_var(--accent)_42%,_transparent)] [&.duration-preset]:[background:var(--active)] [&.inventory-chip]:text-[#fff] [&.inventory-chip]:border-transparent [&.inventory-chip]:[background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [&.inventory-chip]:[box-shadow:0_8px_18px_color-mix(in_srgb,_var(--accent)_26%,_transparent)] [.ap-tabs_&.ap-tab]:[background:rgba(123,_136,_255,_.18)] [.ap-tabs_&.ap-tab]:text-[#aeb6ff] [.ap-tabs_&.ap-tab]:border-transparent [.ap-tabs_&.ap-tab]:[box-shadow:none]' : ''}`}
              onClick={() => setActiveTab('directory')}
            >
              <FaUsers /> Team ({directory.length})
            </button>
          </div>

          {/* Search bar */}
          <div className="p-[4px_14px_10px]">
            <input
              type="text"
              className="w-full p-[8px_12px] [background:var(--input-bg)] border border-input-line rounded-[10px] text-text text-[12px] later:[outline:none] [transition:border-color_0.15s_ease] focus:border-accent"
              placeholder={activeTab === 'chats' ? 'Search channels…' : 'Search colleagues…'}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>

          {/* List area */}
          <div className="flex-1 overflow-y-auto p-[8px_0] flex flex-col">
            {activeTab === 'chats' ? (
              <>
                <div className="p-[8px_16px_4px] text-[11px] font-[700] uppercase tracking-[0.05em] text-muted">Department Rooms</div>
                {filteredChannels
                  .filter((c) => c.type === 'department')
                  .map((chan) => {
                    const meta = getDeptMeta(chan.department, 'department');
                    const Icon = meta.icon;
                    const isSelected = chan.id === activeChannel?.id;
                    const hasUnread = (chan.unread_count || 0) > 0;

                    return (
                      <button
                        key={chan.id}
                        type="button"
                        className={`flex items-center gap-3 p-[10px_16px] cursor-pointer [transition:background_0.15s_ease] border-0 [background:transparent] w-full text-left hover:[background:var(--surface-subtle)] later:[&.active]:[background:var(--active)] ${isSelected ? ' active [&.branch-selector-card]:border-[color:color-mix(in_srgb,_var(--accent)_46%,_var(--border))] [&.branch-selector-card]:[background:linear-gradient(145deg,_color-mix(in_srgb,_var(--accent)_7%,_var(--panel)),_var(--panel))] [&.branch-selector-card]:[box-shadow:0_0_0_3px_color-mix(in_srgb,_var(--accent)_8%,_transparent),_var(--shadow-md)] [&.duration-preset]:text-accent-text [&.duration-preset]:border-[color:color-mix(in_srgb,_var(--accent)_42%,_transparent)] [&.duration-preset]:[background:var(--active)] [&.inventory-chip]:text-[#fff] [&.inventory-chip]:border-transparent [&.inventory-chip]:[background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [&.inventory-chip]:[box-shadow:0_8px_18px_color-mix(in_srgb,_var(--accent)_26%,_transparent)] [.ap-tabs_&.ap-tab]:[background:rgba(123,_136,_255,_.18)] [.ap-tabs_&.ap-tab]:text-[#aeb6ff] [.ap-tabs_&.ap-tab]:border-transparent [.ap-tabs_&.ap-tab]:[box-shadow:none]' : ''}`}
                        onClick={() => selectChannel(chan.id)}
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
                              : chan.description || 'Live room'}
                          </div>
                        </div>
                        {hasUnread && (
                          <span className="[background:var(--accent)] text-[#fff] text-[10px] font-[700] p-[1px_6px] rounded-[10px] shrink-[0]">{chan.unread_count}</span>
                        )}
                      </button>
                    );
                  })}

                {filteredChannels.some((c) => c.type === 'direct') && (
                  <>
                    <div className="p-[8px_16px_4px] text-[11px] font-[700] uppercase tracking-[0.05em] text-muted" style={{ marginTop: '16px' }}>
                      Direct Messages
                    </div>
                    {filteredChannels
                      .filter((c) => c.type === 'direct')
                      .map((chan) => {
                        const isSelected = chan.id === activeChannel?.id;
                        return (
                          <button
                            key={chan.id}
                            type="button"
                            className={`flex items-center gap-3 p-[10px_16px] cursor-pointer [transition:background_0.15s_ease] border-0 [background:transparent] w-full text-left hover:[background:var(--surface-subtle)] later:[&.active]:[background:var(--active)] ${isSelected ? ' active [&.branch-selector-card]:border-[color:color-mix(in_srgb,_var(--accent)_46%,_var(--border))] [&.branch-selector-card]:[background:linear-gradient(145deg,_color-mix(in_srgb,_var(--accent)_7%,_var(--panel)),_var(--panel))] [&.branch-selector-card]:[box-shadow:0_0_0_3px_color-mix(in_srgb,_var(--accent)_8%,_transparent),_var(--shadow-md)] [&.duration-preset]:text-accent-text [&.duration-preset]:border-[color:color-mix(in_srgb,_var(--accent)_42%,_transparent)] [&.duration-preset]:[background:var(--active)] [&.inventory-chip]:text-[#fff] [&.inventory-chip]:border-transparent [&.inventory-chip]:[background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [&.inventory-chip]:[box-shadow:0_8px_18px_color-mix(in_srgb,_var(--accent)_26%,_transparent)] [.ap-tabs_&.ap-tab]:[background:rgba(123,_136,_255,_.18)] [.ap-tabs_&.ap-tab]:text-[#aeb6ff] [.ap-tabs_&.ap-tab]:border-transparent [.ap-tabs_&.ap-tab]:[box-shadow:none]' : ''}`}
                            onClick={() => selectChannel(chan.id)}
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
                        );
                      })}
                  </>
                )}
              </>
            ) : (
              /* Directory View */
              <div>
                <div className="p-[8px_16px_4px] text-[11px] font-[700] uppercase tracking-[0.05em] text-muted">Franchise Titan Directory</div>
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
                      onClick={() => startDirectChat(colleague.id)}
                    >
                      Message
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </aside>

        {/* Center Column: Active Chat Thread */}
        <section className="flex flex-col [background:var(--panel)] relative">
          {/* Thread Header */}
          <div className="p-[12px_16px] [background:var(--panel-2)] border-b border-b-line flex items-center justify-between gap-3 [user-select:none]" style={{ padding: '14px 20px' }}>
            <div className="flex items-center gap-[10px] min-w-0">
              <div className={`w-[38px] h-[38px] rounded-[12px] flex items-center justify-center text-[16px] shrink-[0] ${activeMeta?.className || '[background:rgba(99,_102,_241,_0.18)] text-[#818cf8] border border-[rgba(99,_102,_241,_0.3)]'}`} style={{ width: '36px', height: '36px' }}>
                <ActiveIcon />
              </div>
              <div className="min-w-0">
                <div className="text-[14px] font-[700] text-text whitespace-nowrap overflow-hidden text-ellipsis flex items-center gap-[6px]" style={{ fontSize: '15px' }}>
                  {activeChannel?.name || 'Live Room'}
                </div>
                <div className="inline-flex items-center gap-[5px] text-[11px] font-[500] text-[#22c55e]">
                  <span className="w-[7px] h-[7px] [background:#22c55e] rounded-[50%] [box-shadow:0_0_8px_rgba(34,_197,_94,_0.7)] [animation:pulse-ring_1.8s_infinite]" />
                  <span>
                    {activeChannel?.type === 'direct'
                      ? (activeChannel?.is_online ? 'Active now' : 'Colleague')
                      : (activeChannel?.description || 'Real-time department channel')}
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Messages Scroll Area */}
          <div className="flex-1 overflow-y-auto p-[14px_16px] flex flex-col gap-[10px]" style={{ padding: '18px 24px' }}>
            {messages.length === 0 ? (
              <div style={{ textAlign: 'center', color: 'var(--muted)', margin: 'auto', padding: '32px' }}>
                <FaComments style={{ fontSize: '40px', marginBottom: '12px', opacity: 0.5 }} />
                <h3 style={{ margin: 0, color: 'var(--text)', fontSize: '16px' }}>Welcome to {activeChannel?.name}</h3>
                <p style={{ margin: '6px 0 0', fontSize: '13px' }}>
                  Messages sent here are delivered instantly in real time to all department members.
                </p>
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
                    <div className={`flex gap-2 max-w-[84%] items-end [&.sent-me]:self-end [&.sent-me]:flex-row-reverse later:[&.sent-them]:self-start ${isMe ? 'sent-me' : 'sent-them'}`} style={{ maxWidth: '75%' }}>
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
                        <div className="p-[9px_14px] rounded-[16px] text-[13px] leading-[1.45] [word-break:break-word] relative [.sent-me_&]:[background:linear-gradient(135deg,_var(--accent)_0%,_#4f46e5_100%)] [.sent-me_&]:text-[#fff] [.sent-me_&]:[border-bottom-right-radius:4px] [.sent-me_&]:[box-shadow:0_4px_12px_rgba(79,_70,_229,_0.25)] later:[.sent-them_&]:[background:var(--panel-2)] [.sent-them_&]:border [.sent-them_&]:border-line later:[.sent-them_&]:text-text later:[.sent-them_&]:[border-bottom-left-radius:4px]" style={{ fontSize: '14px', padding: '10px 16px' }}>
                          {msg.message}
                          <div className="flex items-center justify-end gap-1 text-[10px] mt-[3px] opacity-[0.75] [.sent-me_&]:text-[rgba(255,_255,_255,_0.85)] later:[.sent-them_&]:text-muted">
                            <span>{formatMessageTime(msg.created_at)}</span>
                            {isMe && (
                              msg._optimistic ? (
                                <span style={{ opacity: 0.6 }}>•</span>
                              ) : (
                                <FaCheckDouble style={{ fontSize: '10px' }} />
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
          <div className="flex items-center gap-[6px] p-[6px_14px_4px] overflow-x-auto border-t border-t-line [background:var(--panel-2)]" style={{ padding: '8px 20px' }}>
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

          {/* Message Composer */}
          <form className="p-[8px_14px_12px] [background:var(--panel-2)] border-t border-t-line flex items-center gap-2" onSubmit={handleSend} style={{ padding: '12px 20px 16px' }}>
            <input
              ref={inputRef}
              type="text"
              className="flex-1 [background:var(--input-bg)] border border-input-line rounded-[20px] p-[9px_16px] text-[13px] text-text later:[outline:none] [resize:none] max-h-[90px] [transition:border-color_0.15s_ease] later:[font-family:inherit] focus:border-accent"
              placeholder={`Type a message to ${activeChannel?.name || 'the department'}… (Press Enter to send)`}
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={sendingMessage}
              style={{ fontSize: '14px', padding: '12px 20px' }}
            />
            <button
              type="submit"
              className="w-[36px] h-[36px] rounded-[50%] [background:var(--accent)] text-[#fff] border-0 cursor-pointer flex items-center justify-center text-[14px] shrink-[0] [transition:all_0.15s_ease] [box-shadow:0_4px_10px_rgba(99,_102,_241,_0.3)] [&:hover:not(:disabled)]:[transform:scale(1.08)] [&:hover:not(:disabled)]:[background:#4f46e5] disabled:opacity-[0.4] disabled:cursor-not-allowed"
              disabled={!inputText.trim() || sendingMessage}
              title="Send Message"
              style={{ width: '42px', height: '42px', fontSize: '16px' }}
            >
              <FaPaperPlane />
            </button>
          </form>
        </section>

        {/* Right Column: Channel & Department Info */}
        <aside className="max-[1201px]:[.full-messenger-page_&]:hidden border-l border-l-line [background:var(--panel-2)] p-5 flex flex-col gap-[18px] overflow-y-auto">
          <div className="text-center p-[16px_0] border-b border-b-line">
            <div className={`w-[64px] h-[64px] rounded-[20px] m-[0_auto_12px] flex items-center justify-center text-[24px] font-[700] later:text-[#fff] [box-shadow:0_8px_16px_rgba(0,_0,_0,_0.2)] ${activeMeta?.className || '[background:rgba(99,_102,_241,_0.18)] text-[#818cf8] border border-[rgba(99,_102,_241,_0.3)]'}`}>
              <ActiveIcon />
            </div>
            <div className="text-[16px] font-[700] text-text">{activeChannel?.name}</div>
            <div className="text-[12px] text-muted mt-1 leading-[1.4]">
              {activeChannel?.description || 'Active department workspace channel.'}
            </div>
          </div>

          <div className="flex flex-col gap-2 [&_h4]:text-[12px] [&_h4]:font-[700] [&_h4]:uppercase [&_h4]:text-muted [&_h4]:tracking-[0.04em] [&_h4]:m-0">
            <h4>Real-time Network</h4>
            <div className="flex items-center gap-2 p-[6px_8px] rounded-[8px] [background:var(--surface-subtle)] text-[12px] text-text">
              <span className="w-[8px] h-[8px] rounded-[50%] [background:#22c55e]" />
              <span>Real-time Polling: Connected</span>
            </div>
            <div className="flex items-center gap-2 p-[6px_8px] rounded-[8px] [background:var(--surface-subtle)] text-[12px] text-text">
              <span className="w-[8px] h-[8px] rounded-[50%] [background:#22c55e]" />
              <span>Presence Tracking: Active</span>
            </div>
          </div>

          <div className="flex flex-col gap-2 [&_h4]:text-[12px] [&_h4]:font-[700] [&_h4]:uppercase [&_h4]:text-muted [&_h4]:tracking-[0.04em] [&_h4]:m-0">
            <h4>Quick Department Channels</h4>
            {channels
              .filter((c) => c.type === 'department')
              .map((c) => (
                <button
                  key={c.id}
                  type="button"
                  style={{
                    background: c.id === activeChannel?.id ? 'var(--surface-strong)' : 'transparent',
                    border: '1px solid var(--border)',
                    borderRadius: '8px',
                    padding: '8px 12px',
                    color: 'var(--text)',
                    fontSize: '12px',
                    cursor: 'pointer',
                    textAlign: 'left',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                  }}
                  onClick={() => selectChannel(c.id)}
                >
                  <span>{c.name}</span>
                  {c.unread_count > 0 && (
                    <span className="[background:var(--accent)] text-[#fff] text-[10px] font-[700] p-[1px_6px] rounded-[10px] shrink-[0]">{c.unread_count}</span>
                  )}
                </button>
              ))}
          </div>
        </aside>
      </div>
    </div>
  );
}
