import React, { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useDisplayLocale, useDateLocale } from '@/hooks/use-display-locale'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { categories as categoriesApi, categoryGroups as groupsApi, budgets as budgetsApi, dashboard as dashboardApi } from '@/lib/api'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import type { Budget } from '@/types'
import type { CategoryGroup } from '@/types'
import { Pencil, Trash2, Plus, Repeat, CalendarIcon, Info, Percent, TrendingUp, Wallet } from 'lucide-react'
import { format } from 'date-fns'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { MonthPicker } from '@/components/ui/monthpicker'
import { PageHeader } from '@/components/page-header'
import { CategoryIcon } from '@/components/category-icon'
import { usePrivacyMode } from '@/hooks/use-privacy-mode'
import { useAuth } from '@/contexts/auth-context'
import { useWorkspace } from '@/contexts/workspace-context'
import { resolveDateFnsLocale } from '@/lib/date-fns-locale'
import { Skeleton } from '@/components/ui/skeleton'

const SYSTEM_GROUP_META = {
  housing: { icon: 'house', color: '#8b5cf6' },
  food: { icon: 'utensils-crossed', color: '#f59e0b' },
  transport: { icon: 'car', color: '#3b82f6' },
  lifestyle: { icon: 'sparkles', color: '#ec4899' },
  other: { icon: 'circle-help', color: '#64748b' },
} as const

type SystemGroupKey = keyof typeof SYSTEM_GROUP_META

const DEFAULT_50_30_20_GROUPS: { systemKey: SystemGroupKey; percent: number }[] = [
  { systemKey: 'housing', percent: 16.67 },
  { systemKey: 'food', percent: 16.67 },
  { systemKey: 'transport', percent: 16.66 },
  { systemKey: 'lifestyle', percent: 30 },
  { systemKey: 'other', percent: 20 },
]

function normHex(color: string | null | undefined) {
  return (color ?? '').trim().toLowerCase()
}

function findSystemGroup(groups: CategoryGroup[], key: SystemGroupKey): CategoryGroup | undefined {
  const meta = SYSTEM_GROUP_META[key]
  return groups.find(
    (g) => g.is_system && g.icon === meta.icon && normHex(g.color) === meta.color,
  )
}

function formatCurrency(value: number, currency = 'USD', locale = 'en-US') {
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(value)
}

function currentMonth() {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

const TH = 'text-xs font-medium text-muted-foreground py-3'

function SectionCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-card rounded-xl border border-border shadow-sm overflow-hidden">
      {children}
    </div>
  )
}
function SectionHeader({ title, action }: { title: string; action?: React.ReactNode }) {
  return (
    <div className="px-4 sm:px-5 py-4 border-b border-border flex flex-wrap items-center justify-between gap-2">
      <p className="text-sm font-semibold text-foreground">{title}</p>
      {action}
    </div>
  )
}

export default function BudgetsPage() {
  const { t, i18n } = useTranslation()
  const { mask } = usePrivacyMode()
  const { user } = useAuth()
  const { canWrite, current: workspace } = useWorkspace()
  const userCurrency = user?.preferences?.currency_display ?? 'USD'
  const workspaceId = workspace?.id ?? null
  const locale = useDisplayLocale()
  const dateLocale = useDateLocale()
  const queryClient = useQueryClient()
  const [selectedMonth, setSelectedMonth] = useState(currentMonth)
  const [monthCalOpen, setMonthCalOpen] = useState(false)
  const dateFnsLocale = resolveDateFnsLocale(i18n.resolvedLanguage ?? i18n.language)
  const monthParam = `${selectedMonth}-01`
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<Budget | null>(null)
  const [templateDialogOpen, setTemplateDialogOpen] = useState(false)

  type BudgetTemplateGroupAlloc = { systemKey: SystemGroupKey; percent: number }
  type BudgetTemplateState = { version: 2; templateId: '50_30_20'; groups: BudgetTemplateGroupAlloc[] }

  const templateStorageKey = workspaceId ? `budget_template_50_30_20_v2_${workspaceId}` : null
  const [templateState, setTemplateState] = useState<BudgetTemplateState | null>(null)

  useEffect(() => {
    if (!templateStorageKey) {
      setTemplateState(null)
      return
    }

    try {
      const raw = localStorage.getItem(templateStorageKey)
      if (!raw) {
        setTemplateState(null)
        return
      }
      const parsed = JSON.parse(raw) as BudgetTemplateState
      if (
        !parsed
        || parsed.version !== 2
        || parsed.templateId !== '50_30_20'
        || !Array.isArray(parsed.groups)
      ) {
        setTemplateState(null)
        return
      }
      setTemplateState(parsed)
    } catch {
      setTemplateState(null)
    }
  }, [templateStorageKey])

  const { data: groupsList } = useQuery({
    queryKey: ['category-groups'],
    queryFn: groupsApi.list,
  })

  const templateGroups = useMemo(() => {
    if (!templateState || !groupsList) return []
    return templateState.groups
      .map((alloc) => {
        const group = findSystemGroup(groupsList, alloc.systemKey)
        if (!group) return null
        return { group, percent: alloc.percent, systemKey: alloc.systemKey }
      })
      .filter(Boolean) as { group: CategoryGroup; percent: number; systemKey: SystemGroupKey }[]
  }, [templateState, groupsList])

  const templateGroupIdSet = useMemo(() => new Set(templateGroups.map((g) => g.group.id)), [templateGroups])

  const saveTemplateState = (next: BudgetTemplateState | null) => {
    if (!templateStorageKey) return
    if (!next) {
      localStorage.removeItem(templateStorageKey)
      return
    }
    localStorage.setItem(templateStorageKey, JSON.stringify(next))
  }

  // Template editor dialog (percent only — groups are system-owned)
  const [groupDialogOpen, setGroupDialogOpen] = useState(false)
  const [editingSystemGroupKey, setEditingSystemGroupKey] = useState<SystemGroupKey | null>(null)
  const [groupFormPercent, setGroupFormPercent] = useState(0)

  const recalculateTemplateBudgets = async (overrideState?: BudgetTemplateState | null) => {
    const state = overrideState ?? templateState
    if (!state || !workspaceId) return

    // Income is used as the base for 50/30/20 split. If you later modify
    // categories, we keep the split logic but re-bucket across subcategories.
    const summary = await dashboardApi.summary(monthParam)
    const baseIncome = Math.max(0, summary.monthly_income_primary ?? summary.monthly_income ?? 0)

    const groupsFresh = await groupsApi.list()
    const budgetsThisMonth = await budgetsApi.list(monthParam)
    const budgetsByCategoryId = new Map(budgetsThisMonth.map((b) => [b.category_id, b]))

    for (const groupDef of state.groups) {
      const group = findSystemGroup(groupsFresh, groupDef.systemKey)
      if (!group) continue
      const subcats = (group.categories ?? []).filter((c) => !c.treat_as_transfer)
      if (subcats.length === 0) continue

      const bucketAmount = baseIncome * groupDef.percent / 100
      const perSubcat = Number((bucketAmount / subcats.length).toFixed(2))

      for (const cat of subcats) {
        const existing = budgetsByCategoryId.get(cat.id)
        if (existing?.is_recurring) {
          const existingMonth = existing.month.slice(0, 7)
          const currentMonth = monthParam.slice(0, 7)
          if (existingMonth === currentMonth) {
            await budgetsApi.update(existing.id, { amount: perSubcat })
          } else {
            await budgetsApi.update(existing.id, { amount: perSubcat, effective_month: monthParam })
          }
        } else {
          if (existing && !existing.is_recurring) {
            await budgetsApi.delete(existing.id)
          }
          await budgetsApi.create({
            category_id: cat.id,
            amount: perSubcat,
            month: monthParam,
            is_recurring: true,
          })
        }
      }
    }

    queryClient.invalidateQueries({ queryKey: ['budgets'] })
  }

  const openGroupDialogForEdit = (systemKey: SystemGroupKey) => {
    const alloc = templateState?.groups.find((g) => g.systemKey === systemKey)
    if (!alloc) return
    setEditingSystemGroupKey(systemKey)
    setGroupFormPercent(alloc.percent)
    setGroupDialogOpen(true)
  }

  const applyDefaultTemplate = async () => {
    if (!canWrite || !workspaceId) return

    if (templateState?.groups?.length) {
      const ok = window.confirm(t('budgets.templates.replaceConfirm'))
      if (!ok) return
    }

    const groupsFresh = await groupsApi.list()
    const missing = DEFAULT_50_30_20_GROUPS.filter((g) => !findSystemGroup(groupsFresh, g.systemKey))
    if (missing.length > 0) {
      toast.error(t('budgets.templates.systemGroupsMissing'))
      return
    }

    const nextState: BudgetTemplateState = {
      version: 2,
      templateId: '50_30_20',
      groups: DEFAULT_50_30_20_GROUPS.map((g) => ({ ...g })),
    }
    setTemplateState(nextState)
    saveTemplateState(nextState)

    await recalculateTemplateBudgets(nextState)
    queryClient.invalidateQueries({ queryKey: ['budgets'] })

    toast.success(t('budgets.templates.applied'))
  }

  const clearTemplate = () => {
    if (!canWrite) return
    const ok = window.confirm(t('budgets.templates.clearConfirm'))
    if (!ok) return
    setTemplateState(null)
    saveTemplateState(null)
    toast.success(t('budgets.templates.cleared'))
  }

  const upsertTemplateGroupFromDialog = async () => {
    if (!canWrite || !templateState || !editingSystemGroupKey) return

    const nextState: BudgetTemplateState = {
      version: 2,
      templateId: '50_30_20',
      groups: templateState.groups.map((g) =>
        g.systemKey === editingSystemGroupKey ? { ...g, percent: groupFormPercent } : g,
      ),
    }

    setTemplateState(nextState)
    saveTemplateState(nextState)
    await recalculateTemplateBudgets(nextState)
    queryClient.invalidateQueries({ queryKey: ['budgets'] })
    toast.success(t('budgets.templates.groupUpdated'))
    setGroupDialogOpen(false)
    setEditingSystemGroupKey(null)
  }

  const { data: budgetsList } = useQuery({
    queryKey: ['budgets', selectedMonth],
    queryFn: () => budgetsApi.list(monthParam),
  })

  const { data: monthSummary, isLoading: monthSummaryLoading } = useQuery({
    queryKey: ['dashboard-summary', selectedMonth],
    queryFn: () => dashboardApi.summary(monthParam),
  })

  const { data: categoriesList } = useQuery({
    queryKey: ['categories'],
    queryFn: categoriesApi.list,
  })

  const createMutation = useMutation({
    mutationFn: (data: { category_id: string; amount: number; month: string; is_recurring?: boolean }) =>
      budgetsApi.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['budgets'] })
      setDialogOpen(false)
      toast.success(t('budgets.created'))
    },
    onError: () => toast.error(t('common.error')),
  })

  const updateMutation = useMutation({
    mutationFn: ({
      id,
      amount,
      effective_month,
    }: {
      id: string
      amount: number
      effective_month?: string
    }) => budgetsApi.update(id, { amount, effective_month }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['budgets'] })
      setDialogOpen(false)
      setEditing(null)
      toast.success(t('budgets.updated'))
    },
    onError: () => toast.error(t('common.error')),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => budgetsApi.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['budgets'] })
      toast.success(t('budgets.deleted'))
    },
  })

  const getCategoryDisplay = (categoryId: string) => {
    const cat = categoriesList?.find((c) => c.id === categoryId)
    if (!cat) return <span>{categoryId}</span>
    return (
      <span className="flex items-center gap-2">
        <CategoryIcon icon={cat.icon} color={cat.color} size="sm" />
        <span>{cat.name}</span>
      </span>
    )
  }

  const incomeGroupIds = useMemo(() => {
    if (!groupsList) return new Set<string>()
    return new Set(
      groupsList
        .filter((g) => g.is_system && g.icon === 'trending-up' && normHex(g.color) === '#16a34a')
        .map((g) => g.id),
    )
  }, [groupsList])

  const monthlyIncome = Number(
    monthSummary?.monthly_income_primary ?? monthSummary?.monthly_income ?? 0,
  )
  const primaryCurrency = monthSummary?.primary_currency ?? userCurrency

  const plannedTotal = useMemo(() => {
    if (!budgetsList) return 0
    const catById = new Map(categoriesList?.map((c) => [c.id, c]) ?? [])
    return budgetsList.reduce((sum, b) => {
      const cat = catById.get(b.category_id)
      if (cat?.treat_as_transfer) return sum
      if (cat?.group_id && incomeGroupIds.has(cat.group_id)) return sum
      return sum + Number(b.amount)
    }, 0)
  }, [budgetsList, categoriesList, incomeGroupIds])

  const incomeDelta = monthlyIncome - plannedTotal
  const plannedSharePct =
    monthlyIncome > 0 ? Math.round((plannedTotal / monthlyIncome) * 100) : null

  const monthTitle = new Date(selectedMonth + '-02').toLocaleDateString(dateLocale, { month: 'long', year: 'numeric' }).replace(/^\w/, c => c.toUpperCase())

  return (
    <div>
      <PageHeader
        section={t('budgets.title')}
        title={monthTitle}
        action={
          <div className="flex items-center gap-1">
            <button
              className="h-8 w-8 flex items-center justify-center rounded-lg border border-border bg-card text-muted-foreground hover:border-border hover:text-foreground transition-all text-base"
              onClick={() => {
                const [y, m] = selectedMonth.split('-').map(Number)
                const d = new Date(y, m - 2, 1)
                setSelectedMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`)
              }}
            >‹</button>
            <Popover open={monthCalOpen} onOpenChange={setMonthCalOpen}>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className="inline-flex items-center justify-center gap-2 border border-border rounded-lg px-3 py-1.5 text-sm bg-card text-foreground hover:bg-muted/50 transition-all cursor-pointer min-w-[180px]"
                >
                  <CalendarIcon className="size-3.5 text-muted-foreground" />
                  {monthTitle}
                </button>
              </PopoverTrigger>
              <PopoverContent align="center" className="w-auto p-0">
                <MonthPicker
                  locale={dateFnsLocale}
                  selectedMonth={new Date(`${selectedMonth}-01T00:00:00`)}
                  onMonthSelect={(date) => {
                    if (!date) return
                    setSelectedMonth(format(date, 'yyyy-MM'))
                    setMonthCalOpen(false)
                  }}
                />
              </PopoverContent>
            </Popover>
            <button
              className="h-8 w-8 flex items-center justify-center rounded-lg border border-border bg-card text-muted-foreground hover:border-border hover:text-foreground transition-all text-base"
              onClick={() => {
                const [y, m] = selectedMonth.split('-').map(Number)
                const d = new Date(y, m, 1)
                setSelectedMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`)
              }}
            >›</button>
          </div>
        }
      />

      <div className="mt-6 space-y-8">
      <SectionCard>
        <SectionHeader title={t('budgets.incomeComparison')} />
        <div className="p-4 sm:p-5 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="rounded-lg border border-border bg-muted/20 p-4">
              <div className="flex items-center gap-2 text-muted-foreground mb-2">
                <TrendingUp size={15} />
                <p className="text-xs font-medium">{t('budgets.monthlyIncome')}</p>
              </div>
              {monthSummaryLoading ? (
                <Skeleton className="h-8 w-28" />
              ) : (
                <p className="text-2xl font-bold tabular-nums text-emerald-600">
                  {mask(formatCurrency(monthlyIncome, primaryCurrency, locale))}
                </p>
              )}
            </div>

            <div className="rounded-lg border border-border bg-muted/20 p-4">
              <div className="flex items-center gap-2 text-muted-foreground mb-2">
                <Wallet size={15} />
                <p className="text-xs font-medium">{t('budgets.plannedTotal')}</p>
              </div>
              {budgetsList === undefined ? (
                <Skeleton className="h-8 w-28" />
              ) : (
                <p className="text-2xl font-bold tabular-nums text-foreground">
                  {mask(formatCurrency(plannedTotal, primaryCurrency, locale))}
                </p>
              )}
            </div>

            <div className="rounded-lg border border-border bg-muted/20 p-4">
              <p className="text-xs font-medium text-muted-foreground mb-2">
                {incomeDelta >= 0 ? t('budgets.remaining') : t('budgets.overPlanned')}
              </p>
              {monthSummaryLoading || budgetsList === undefined ? (
                <Skeleton className="h-8 w-28" />
              ) : (
                <p className={`text-2xl font-bold tabular-nums ${incomeDelta >= 0 ? 'text-emerald-600' : 'text-rose-500'}`}>
                  {mask(formatCurrency(Math.abs(incomeDelta), primaryCurrency, locale))}
                </p>
              )}
              {plannedSharePct !== null && !monthSummaryLoading && budgetsList !== undefined && (
                <p className="text-xs text-muted-foreground mt-1">
                  {t('budgets.plannedShare', { pct: plannedSharePct })}
                </p>
              )}
            </div>
          </div>

          {monthlyIncome > 0 && budgetsList !== undefined && (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>{t('budgets.plannedTotal')}</span>
                <span>{plannedSharePct}%</span>
              </div>
              <div className="h-2 rounded-full bg-muted overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all ${plannedSharePct !== null && plannedSharePct > 100 ? 'bg-rose-500' : 'bg-primary'}`}
                  style={{ width: `${Math.min(plannedSharePct ?? 0, 100)}%` }}
                />
              </div>
            </div>
          )}

          {monthlyIncome === 0 && !monthSummaryLoading && plannedTotal > 0 && (
            <p className="text-sm text-muted-foreground">{t('budgets.noIncomeHint')}</p>
          )}
        </div>
      </SectionCard>

      <SectionCard>
        <SectionHeader
          title={t('budgets.title')}
          action={
            <div className="flex gap-2 items-center">
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5 h-8"
                onClick={() => setTemplateDialogOpen(true)}
              >
                <Percent size={13} /> {t('budgets.templates.templateName')}
              </Button>
              {canWrite ? (
                <Button size="sm" className="gap-1.5 h-8" onClick={() => { setEditing(null); setDialogOpen(true) }}>
                  <Plus size={13} /> {t('budgets.add')}
                </Button>
              ) : undefined}
            </div>
          }
        />
        {budgetsList && budgetsList.length > 0 ? (
          <table className="w-full">
            <thead>
              <tr className="border-b border-border">
                <th className={`${TH} pl-4 sm:pl-5 text-left`}>{t('budgets.category')}</th>
                <th className={`${TH} text-left w-36`}>{t('budgets.amount')}</th>
                {canWrite && <th className={`${TH} pr-4 sm:pr-5 text-right w-24`}>{t('budgets.actions')}</th>}
              </tr>
            </thead>
            <tbody>
              {budgetsList.map((budget) => (
                <tr key={budget.id} className="border-b border-border last:border-0 hover:bg-muted transition-colors">
                  <td className="py-3 pl-4 sm:pl-5 text-sm font-medium text-foreground">
                    <span className="flex items-center gap-1.5">
                      {getCategoryDisplay(budget.category_id)}
                      {budget.is_recurring && (
                        <span title={t('budgets.recurringLabel')} className="text-muted-foreground">
                          <Repeat size={12} />
                        </span>
                      )}
                    </span>
                  </td>
                  <td className="py-3 text-sm font-semibold tabular-nums text-foreground">{mask(formatCurrency(budget.amount, userCurrency, locale))}</td>
                  {canWrite && (
                    <td className="py-3 pr-4 sm:pr-5">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          className="p-1.5 rounded-md text-muted-foreground hover:text-primary hover:bg-primary/5 transition-colors"
                          onClick={() => { setEditing(budget); setDialogOpen(true) }}
                        >
                          <Pencil size={13} />
                        </button>
                        <button
                          className="p-1.5 rounded-md text-muted-foreground hover:text-rose-500 hover:bg-rose-50 transition-colors"
                          onClick={() => deleteMutation.mutate(budget.id)}
                          disabled={deleteMutation.isPending}
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-sm text-muted-foreground text-center py-10">{t('budgets.empty')}</p>
        )}
      </SectionCard>
      </div>

      <Dialog
        open={templateDialogOpen}
        onOpenChange={(open) => setTemplateDialogOpen(open)}
      >
        <DialogContent className="sm:max-w-3xl w-[calc(100%-2rem)] max-h-[min(92vh,52rem)] p-0 gap-0 flex flex-col overflow-hidden">
          <DialogHeader className="px-5 pt-5 pr-12 pb-4 border-b border-border shrink-0 space-y-1">
            <DialogTitle>{t('budgets.templates.title')}</DialogTitle>
            <p className="text-sm text-muted-foreground font-normal">{t('budgets.templates.description')}</p>
          </DialogHeader>

          {canWrite && (
            <div className="px-5 py-3 border-b border-border shrink-0 flex flex-wrap gap-2">
              <Button size="sm" variant="outline" className="gap-1.5 h-8" onClick={applyDefaultTemplate}>
                <Info size={13} /> {t('budgets.templates.apply50_30_20')}
              </Button>
              {templateState ? (
                <>
                  <Button
                    size="sm"
                    className="gap-1.5 h-8"
                    onClick={async () => {
                      await recalculateTemplateBudgets()
                      toast.success(t('budgets.templates.recalculated'))
                    }}
                  >
                    <Percent size={13} /> {t('budgets.templates.recalculate')}
                  </Button>
                  <Button size="sm" variant="outline" className="gap-1.5 h-8" onClick={clearTemplate}>
                    <Trash2 size={13} /> {t('budgets.templates.removeTemplate')}
                  </Button>
                </>
              ) : null}
            </div>
          )}

          <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4 min-h-0">
            {!templateState || templateState.groups.length === 0 ? (
              <div className="rounded-lg border border-border bg-muted/30 p-4">
                <p className="text-sm text-muted-foreground">{t('budgets.templates.notApplied')}</p>
                {canWrite && (
                  <Button className="mt-3 w-full sm:w-auto gap-1.5" onClick={applyDefaultTemplate}>
                    <Plus size={14} /> {t('budgets.templates.apply50_30_20')}
                  </Button>
                )}
              </div>
            ) : (
              <>
                <p className="text-sm text-muted-foreground">{t('budgets.templates.manageHint')}</p>
                <div className="space-y-3">
                  {templateGroups.map(({ group, percent, systemKey }) => {
                    const budgetCategories = (group.categories ?? []).filter((c) => !c.treat_as_transfer)
                    return (
                      <div key={group.id} className="border border-border rounded-lg p-3">
                        <div className="flex items-start gap-3">
                          <CategoryIcon icon={group.icon} color={group.color} size="sm" className="shrink-0" />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="font-semibold text-foreground">{group.name}</span>
                              <span className="text-xs text-muted-foreground">{percent}%</span>
                              <span className="text-xs text-muted-foreground">
                                ({budgetCategories.length} {t('budgets.templates.categoriesLabel')})
                              </span>
                            </div>
                            <div className="mt-2 space-y-1">
                              {budgetCategories.length > 0 ? (
                                budgetCategories.map((cat) => (
                                  <div key={cat.id} className="flex items-center gap-2 py-1.5 px-2 rounded-md">
                                    <CategoryIcon icon={cat.icon} color={cat.color} size="sm" />
                                    <span className="text-sm text-foreground truncate">{cat.name}</span>
                                  </div>
                                ))
                              ) : (
                                <p className="text-sm text-muted-foreground py-2 px-2">{t('budgets.templates.groupEmpty')}</p>
                              )}
                            </div>
                          </div>
                          {canWrite && (
                            <button
                              className="p-1.5 rounded-md text-muted-foreground hover:text-primary hover:bg-primary/5 transition-colors shrink-0"
                              onClick={() => openGroupDialogForEdit(systemKey)}
                              title={t('budgets.templates.editPercent')}
                            >
                              <Pencil size={13} />
                            </button>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Template percent dialog */}
      <Dialog
        open={groupDialogOpen}
        onOpenChange={() => {
          setGroupDialogOpen(false)
          setEditingSystemGroupKey(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('budgets.templates.editPercent')}</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              void upsertTemplateGroupFromDialog()
            }}
            className="space-y-4"
          >
            {editingSystemGroupKey && groupsList && (
              <div className="flex items-center gap-2 text-sm text-foreground">
                <CategoryIcon
                  icon={findSystemGroup(groupsList, editingSystemGroupKey)?.icon ?? 'circle-help'}
                  color={findSystemGroup(groupsList, editingSystemGroupKey)?.color ?? '#64748B'}
                  size="sm"
                />
                <span className="font-medium">{findSystemGroup(groupsList, editingSystemGroupKey)?.name}</span>
              </div>
            )}
            <div className="space-y-2">
              <Label>{t('budgets.templates.groupPercent')}</Label>
              <Input
                type="number"
                value={Number.isFinite(groupFormPercent) ? groupFormPercent : 0}
                min={0}
                max={100}
                step={0.01}
                onChange={(e) => setGroupFormPercent(parseFloat(e.target.value || '0'))}
                required
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setGroupDialogOpen(false)}>
                {t('common.cancel')}
              </Button>
              <Button type="submit">
                {t('common.save')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={dialogOpen} onOpenChange={() => { setDialogOpen(false); setEditing(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? t('budgets.edit') : t('budgets.add')}</DialogTitle>
          </DialogHeader>
          <form
            key={editing?.id ?? 'new'}
            onSubmit={(e) => {
              e.preventDefault()
              const formData = new FormData(e.currentTarget)
              if (editing) {
                const budgetMonth = editing.month.slice(0, 7)
                const needsEffectiveMonth =
                  editing.is_recurring && budgetMonth !== selectedMonth
                updateMutation.mutate({
                  id: editing.id,
                  amount: parseFloat(formData.get('amount') as string),
                  effective_month: needsEffectiveMonth ? monthParam : undefined,
                })
              } else {
                const onlyThisMonth = formData.get('only_this_month') === 'on'
                createMutation.mutate({
                  category_id: formData.get('category_id') as string,
                  amount: parseFloat(formData.get('amount') as string),
                  month: monthParam,
                  is_recurring: !onlyThisMonth,
                })
              }
            }}
            className="space-y-4"
          >
            {!editing && (
              <>
                <div className="space-y-2">
                  <Label>{t('budgets.category')}</Label>
                  <select
                    name="category_id"
                    className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-card text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
                    required
                  >
                    <option value="">{t('budgets.selectCategory')}</option>
                    {(templateState ? groupsList?.filter((g) => templateGroupIdSet.has(g.id)) : groupsList)?.map((group) => (
                      <optgroup key={group.id} label={group.name}>
                        {group.categories.map((cat) => (
                          <option key={cat.id} value={cat.id}>{cat.name}</option>
                        ))}
                      </optgroup>
                    ))}
                    {!templateState &&
                      categoriesList?.filter((c) => !c.group_id).map((cat) => (
                        <option key={cat.id} value={cat.id}>{cat.name}</option>
                      ))}
                  </select>
                </div>
                <p className="text-xs text-muted-foreground">{t('budgets.recurringDefaultHint')}</p>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" name="only_this_month" className="rounded border-border" />
                  <span className="text-sm text-foreground">{t('budgets.onlyThisMonth')}</span>
                </label>
              </>
            )}
            <div className="space-y-2">
              <Label>{t('budgets.amount')}</Label>
              <Input
                name="amount"
                type="number"
                step="0.01"
                defaultValue={editing?.amount?.toString() ?? ''}
                required
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => { setDialogOpen(false); setEditing(null) }}>
                {t('common.cancel')}
              </Button>
              <Button type="submit" disabled={createMutation.isPending || updateMutation.isPending}>
                {t('common.save')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}
