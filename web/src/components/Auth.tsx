import { useState, type FormEvent } from 'react'
import { ArrowRight, LoaderCircle, LockKeyhole, ShieldCheck, TriangleAlert, UserCog } from 'lucide-react'
import { post } from '../api'

type Props = {
  mode: 'setup' | 'login'
  brand: string
  onDone: () => void
}

export default function Auth({ mode, brand, onDone }: Props) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [setupKey, setSetupKey] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setError('')
    if (mode === 'setup') {
      if (password.length < 10) {
        setError('密码至少 10 个字符')
        return
      }
      if (password !== confirm) {
        setError('两次输入的密码不一致')
        return
      }
    }
    setBusy(true)
    try {
      if (mode === 'setup') {
        await post('/api/v1/setup', { username, password, setup_key: setupKey })
        setSetupKey('')
      } else {
        await post('/api/v1/auth/login', { username, password })
      }
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : '操作失败')
    } finally {
      setBusy(false)
    }
  }

  const isSetup = mode === 'setup'

  return (
    <div className="auth">
      <form className="card auth-card" onSubmit={submit}>
        <div className="auth-brand">
          <div className="brand-mark">
            {isSetup ? <ShieldCheck size={21} /> : <LockKeyhole size={20} />}
          </div>
          <div className="brand-text">
            <strong>{brand}</strong>
          </div>
        </div>

        <div>
          <h1>{isSetup ? '设置管理员账号' : '登录面板'}</h1>
          <p className="lede">
            {isSetup
              ? '先验证部署者身份，再创建管理员账号。登录密码由你设置，云服务和通知可在进入面板后配置。'
              : '输入管理员账号进入控制台。连续失败 8 次会锁定 5 分钟。'}
          </p>
        </div>

        <div className="auth-form">
          {isSetup && (
            <div className="field">
              <label htmlFor="setup-key"><ShieldCheck size={13} /> 初始化验证密钥</label>
              <input
                id="setup-key"
                className="input"
                type="password"
                value={setupKey}
                onChange={(event) => setSetupKey(event.target.value)}
                autoComplete="off"
                placeholder="部署时保存的 SESSION_SECRET"
                required
              />
              <div className="hint">仅首次初始化时验证，不作为日常登录密码。</div>
            </div>
          )}
          <div className="field">
            <label htmlFor="username">
              <UserCog size={13} /> 用户名
            </label>
            <input
              id="username"
              className="input"
              value={username}
              autoComplete="username"
              autoFocus
              onChange={(event) => setUsername(event.target.value)}
              placeholder={isSetup ? '例如 admin' : ''}
              required
            />
          </div>

          <div className="field">
            <label htmlFor="password">
              <LockKeyhole size={13} /> 密码
            </label>
            <input
              id="password"
              className="input"
              type="password"
              value={password}
              autoComplete={isSetup ? 'new-password' : 'current-password'}
              onChange={(event) => setPassword(event.target.value)}
              placeholder={isSetup ? '至少 10 个字符' : ''}
              required
            />
          </div>

          {isSetup && (
            <div className="field">
              <label htmlFor="confirm">
                <LockKeyhole size={13} /> 确认密码
              </label>
              <input
                id="confirm"
                className="input"
                type="password"
                value={confirm}
                autoComplete="new-password"
                onChange={(event) => setConfirm(event.target.value)}
                required
              />
            </div>
          )}

          {error && (
            <div className="auth-error">
              <TriangleAlert size={14} />
              {error}
            </div>
          )}

          <button className="btn primary block" type="submit" disabled={busy}>
            {busy ? <LoaderCircle size={15} className="spin" /> : <ArrowRight size={15} />}
            {isSetup ? '创建并进入' : '登录'}
          </button>
        </div>

        <div className="auth-foot">
          {isSetup
            ? '请确认这是你部署的面板地址。数据加密密钥 ENCRYPTION_KEY 请妥善备份。'
            : '忘记密码请按项目文档恢复管理员账号，勿删除数据库，以免丢失配置。'}
        </div>
      </form>
    </div>
  )
}
