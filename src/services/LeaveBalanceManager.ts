import { LeaveBalance, LeaveRequest, LeaveTypeCode } from '../types';
import { roundHours } from '../utils/dateUtils';

export interface DeductionResult {
  success: boolean;
  deductedHours: number;
  remainingBalance: number;
  previousUsedHours: number;
  previousBalance: number;
  insufficientBalance: boolean;
  message: string;
}

export interface RollbackResult {
  success: boolean;
  rolledBackHours: number;
  remainingBalance: number;
  previousUsedHours: number;
  currentUsedHours: number;
  message: string;
}

export class LeaveBalanceManager {
  private balances: Map<string, LeaveBalance>;

  constructor(initialBalances: LeaveBalance[] = []) {
    this.balances = new Map();
    initialBalances.forEach((b) => this.setBalance(b));
  }

  private getKey(employeeId: string, leaveTypeCode: LeaveTypeCode): string {
    return `${employeeId}_${leaveTypeCode}`;
  }

  setBalance(balance: LeaveBalance): void {
    this.balances.set(this.getKey(balance.employeeId, balance.leaveTypeCode), {
      ...balance,
    });
  }

  setBalances(balances: LeaveBalance[]): void {
    balances.forEach((b) => this.setBalance(b));
  }

  getBalance(employeeId: string, leaveTypeCode: LeaveTypeCode): LeaveBalance | undefined {
    return this.balances.get(this.getKey(employeeId, leaveTypeCode));
  }

  getRemainingBalance(employeeId: string, leaveTypeCode: LeaveTypeCode): number {
    const balance = this.getBalance(employeeId, leaveTypeCode);
    if (!balance) return 0;
    return roundHours(
      Math.max(0, balance.totalHours - balance.usedHours - balance.frozenHours)
    );
  }

  getAvailableBalance(employeeId: string, leaveTypeCode: LeaveTypeCode): number {
    return this.getRemainingBalance(employeeId, leaveTypeCode);
  }

  hasSufficientBalance(employeeId: string, leaveTypeCode: LeaveTypeCode, requiredHours: number): boolean {
    return this.getRemainingBalance(employeeId, leaveTypeCode) >= requiredHours;
  }

  deduct(
    employeeId: string,
    leaveTypeCode: LeaveTypeCode,
    hours: number,
    requestId?: string
  ): DeductionResult {
    const roundedHours = roundHours(hours);
    const key = this.getKey(employeeId, leaveTypeCode);
    let balance = this.balances.get(key);

    if (!balance) {
      balance = {
        employeeId,
        leaveTypeCode,
        totalHours: 0,
        usedHours: 0,
        frozenHours: 0,
      };
      this.balances.set(key, balance);
    }

    const previousUsedHours = balance.usedHours;
    const previousBalance = roundHours(balance.totalHours - balance.usedHours - balance.frozenHours);
    const remaining = roundHours(balance.totalHours - balance.usedHours - balance.frozenHours);

    if (remaining < roundedHours) {
      return {
        success: false,
        deductedHours: 0,
        remainingBalance: remaining,
        previousUsedHours,
        previousBalance,
        insufficientBalance: true,
        message: `额度不足，剩余 ${remaining} 小时，申请 ${roundedHours} 小时`,
      };
    }

    balance.usedHours = roundHours(balance.usedHours + roundedHours);

    return {
      success: true,
      deductedHours: roundedHours,
      remainingBalance: roundHours(balance.totalHours - balance.usedHours - balance.frozenHours),
      previousUsedHours,
      previousBalance,
      insufficientBalance: false,
      message: `成功扣减 ${roundedHours} 小时`,
    };
  }

  freeze(employeeId: string, leaveTypeCode: LeaveTypeCode, hours: number): boolean {
    const roundedHours = roundHours(hours);
    const key = this.getKey(employeeId, leaveTypeCode);
    let balance = this.balances.get(key);

    if (!balance) {
      return false;
    }

    const remaining = roundHours(balance.totalHours - balance.usedHours - balance.frozenHours);
    if (remaining < roundedHours) {
      return false;
    }

    balance.frozenHours = roundHours(balance.frozenHours + roundedHours);
    return true;
  }

  unfreeze(employeeId: string, leaveTypeCode: LeaveTypeCode, hours: number): boolean {
    const roundedHours = roundHours(hours);
    const key = this.getKey(employeeId, leaveTypeCode);
    const balance = this.balances.get(key);

    if (!balance) {
      return false;
    }

    if (balance.frozenHours < roundedHours) {
      return false;
    }

    balance.frozenHours = roundHours(balance.frozenHours - roundedHours);
    return true;
  }

  rollback(
    employeeId: string,
    leaveTypeCode: LeaveTypeCode,
    hours: number
  ): RollbackResult {
    const roundedHours = roundHours(hours);
    const key = this.getKey(employeeId, leaveTypeCode);
    const balance = this.balances.get(key);

    if (!balance) {
      return {
        success: false,
        rolledBackHours: 0,
        remainingBalance: 0,
        previousUsedHours: 0,
        currentUsedHours: 0,
        message: '未找到对应的额度记录',
      };
    }

    const previousUsedHours = balance.usedHours;
    const actualRollback = Math.min(roundedHours, balance.usedHours);

    balance.usedHours = roundHours(balance.usedHours - actualRollback);

    return {
      success: true,
      rolledBackHours: actualRollback,
      remainingBalance: roundHours(balance.totalHours - balance.usedHours - balance.frozenHours),
      previousUsedHours,
      currentUsedHours: balance.usedHours,
      message: `成功回滚 ${actualRollback} 小时`,
    };
  }

  rollbackByRequest(request: LeaveRequest): RollbackResult {
    if (request.status !== 'cancelled' && request.status !== 'rejected') {
      return {
        success: false,
        rolledBackHours: 0,
        remainingBalance: 0,
        previousUsedHours: 0,
        currentUsedHours: 0,
        message: '只有已撤销或已拒绝的请假单可以回滚额度',
      };
    }

    const hoursToRollback = request.deductedHours || 0;
    return this.rollback(request.employeeId, request.leaveTypeCode, hoursToRollback);
  }

  increaseBalance(employeeId: string, leaveTypeCode: LeaveTypeCode, hours: number): LeaveBalance {
    const roundedHours = roundHours(hours);
    const key = this.getKey(employeeId, leaveTypeCode);
    let balance = this.balances.get(key);

    if (!balance) {
      balance = {
        employeeId,
        leaveTypeCode,
        totalHours: 0,
        usedHours: 0,
        frozenHours: 0,
      };
      this.balances.set(key, balance);
    }

    balance.totalHours = roundHours(balance.totalHours + roundedHours);
    return { ...balance };
  }

  decreaseBalance(employeeId: string, leaveTypeCode: LeaveTypeCode, hours: number): boolean {
    const roundedHours = roundHours(hours);
    const key = this.getKey(employeeId, leaveTypeCode);
    const balance = this.balances.get(key);

    if (!balance) {
      return false;
    }

    const available = balance.totalHours - balance.usedHours - balance.frozenHours;
    if (available < roundedHours) {
      return false;
    }

    balance.totalHours = roundHours(balance.totalHours - roundedHours);
    return true;
  }

  getAllBalances(employeeId?: string): LeaveBalance[] {
    const balances = Array.from(this.balances.values());
    if (employeeId) {
      return balances.filter((b) => b.employeeId === employeeId);
    }
    return balances;
  }

  clearBalances(): void {
    this.balances.clear();
  }

  resetBalance(employeeId: string, leaveTypeCode: LeaveTypeCode): void {
    const key = this.getKey(employeeId, leaveTypeCode);
    const balance = this.balances.get(key);
    if (balance) {
      balance.usedHours = 0;
      balance.frozenHours = 0;
    }
  }
}
