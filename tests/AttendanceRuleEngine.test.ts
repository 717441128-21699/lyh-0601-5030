import {
  AttendanceRuleEngine,
  Shift,
  LeaveType,
  LeaveBalance,
  WorkSchedule,
  PunchRecord,
  OvertimeRecord,
  HolidayConfig,
  LeaveRequest,
} from '../src';

describe('AttendanceRuleEngine', () => {
  let engine: AttendanceRuleEngine;

  const standardShift: Shift = {
    id: 'shift_standard',
    name: '标准班',
    startTime: '09:00',
    endTime: '18:00',
    restStartTime: '12:00',
    restEndTime: '13:00',
    lateGraceMinutes: 5,
    earlyLeaveGraceMinutes: 5,
    workDays: [1, 2, 3, 4, 5],
  };

  const annualLeaveType: LeaveType = {
    code: 'annual',
    name: '年假',
    unit: 'day',
    paid: true,
    skipHolidays: true,
    skipWeekends: true,
    requiresApproval: true,
  };

  const sickLeaveType: LeaveType = {
    code: 'sick',
    name: '病假',
    unit: 'hour',
    paid: true,
    skipHolidays: true,
    skipWeekends: true,
    minUnitHours: 0.5,
    requiresApproval: true,
  };

  const compensatoryLeaveType: LeaveType = {
    code: 'compensatory',
    name: '调休',
    unit: 'hour',
    paid: true,
    skipHolidays: true,
    skipWeekends: true,
    requiresApproval: true,
  };

  const holidays: HolidayConfig[] = [
    { date: '2025-01-01', name: '元旦', type: 'holiday' },
    { date: '2025-01-28', name: '除夕', type: 'holiday' },
    { date: '2025-01-29', name: '春节', type: 'holiday' },
    { date: '2025-01-30', name: '春节', type: 'holiday' },
    { date: '2025-01-31', name: '春节', type: 'holiday' },
    { date: '2025-02-01', name: '春节', type: 'holiday' },
    { date: '2025-02-02', name: '春节', type: 'holiday' },
    { date: '2025-02-08', name: '春节调休上班', type: 'makeup_workday' },
  ];

  beforeEach(() => {
    engine = new AttendanceRuleEngine({
      holidays,
      shifts: [standardShift],
      leaveTypes: [annualLeaveType, sickLeaveType, compensatoryLeaveType],
    });
  });

  describe('工作日判断', () => {
    it('应正确判断工作日', () => {
      expect(engine.isWorkDay('2025-01-06')).toBe(true);
      expect(engine.isWorkDay('2025-01-07')).toBe(true);
      expect(engine.isWorkDay('2025-01-10')).toBe(true);
    });

    it('应正确判断周末', () => {
      expect(engine.isWeekend('2025-01-04')).toBe(true);
      expect(engine.isWeekend('2025-01-05')).toBe(true);
      expect(engine.isWorkDay('2025-01-04')).toBe(false);
    });

    it('应正确判断节假日', () => {
      expect(engine.isHoliday('2025-01-01')).toBe(true);
      expect(engine.isWorkDay('2025-01-01')).toBe(false);
      const holidayInfo = engine.getHolidayInfo('2025-01-01');
      expect(holidayInfo?.name).toBe('元旦');
    });

    it('应正确判断调休补班日', () => {
      expect(engine.isHoliday('2025-02-08')).toBe(false);
      expect(engine.isWeekend('2025-02-08')).toBe(true);
      expect(engine.isWorkDay('2025-02-08')).toBe(true);
    });
  });

  describe('自定义周末配置', () => {
    it('配置周五周六为休息日后，周五不再是工作日', () => {
      engine.setWeekendConfig({ days: [5, 6] });
      expect(engine.isWorkDay('2025-01-03')).toBe(false);
      expect(engine.isWorkDay('2025-01-04')).toBe(false);
      expect(engine.isWorkDay('2025-01-06')).toBe(true);
    });

    it('自定义周末下，调休补班日仍然覆盖周末规则', () => {
      engine.setWeekendConfig({ days: [5, 6] });
      expect(engine.isWorkDay('2025-02-08')).toBe(true);
    });

    it('getDayType 四种结果均正确', () => {
      engine.setWeekendConfig({ days: [5, 6] });
      const checker = engine.getWorkdayChecker();

      expect(checker.getDayType('2025-01-03')).toBe('weekend');
      expect(checker.getDayType('2025-01-01')).toBe('holiday');
      expect(checker.getDayType('2025-02-08')).toBe('makeup_workday');
      expect(checker.getDayType('2025-01-06')).toBe('workday');
    });
  });

  describe('班次时长计算', () => {
    it('应正确计算标准班次时长', () => {
      const result = engine.calculateShiftHours(standardShift);
      expect(result.totalHours).toBe(9);
      expect(result.restMinutes).toBe(60);
      expect(result.workHours).toBe(8);
    });
  });

  describe('请假额度管理', () => {
    beforeEach(() => {
      const balance: LeaveBalance = {
        employeeId: 'emp_001',
        leaveTypeCode: 'annual',
        totalHours: 80,
        usedHours: 8,
        frozenHours: 0,
      };
      engine.setLeaveBalance(balance);
    });

    it('应正确获取剩余额度', () => {
      expect(engine.getLeaveBalance('emp_001', 'annual')).toBe(72);
    });

    it('应正确扣减额度', () => {
      const manager = engine.getLeaveBalanceManager();
      const result = manager.deduct('emp_001', 'annual', 16);
      expect(result.success).toBe(true);
      expect(result.deductedHours).toBe(16);
      expect(result.remainingBalance).toBe(56);
    });

    it('额度不足时扣减失败', () => {
      const manager = engine.getLeaveBalanceManager();
      const result = manager.deduct('emp_001', 'annual', 100);
      expect(result.success).toBe(false);
      expect(result.insufficientBalance).toBe(true);
    });

    it('应正确回滚额度', () => {
      const manager = engine.getLeaveBalanceManager();
      manager.deduct('emp_001', 'annual', 16);
      const rollback = manager.rollback('emp_001', 'annual', 16);
      expect(rollback.success).toBe(true);
      expect(rollback.rolledBackHours).toBe(16);
      expect(engine.getLeaveBalance('emp_001', 'annual')).toBe(72);
    });
  });

  describe('请假计算与拆分', () => {
    it('应正确计算单日请假时长', () => {
      const schedules: WorkSchedule[] = [
        {
          employeeId: 'emp_001',
          date: '2025-01-06',
          shiftId: 'shift_standard',
          shift: standardShift,
        },
      ];

      const result = engine.calculateLeave({
        employeeId: 'emp_001',
        leaveTypeCode: 'annual',
        startTime: '2025-01-06 09:00:00',
        endTime: '2025-01-06 18:00:00',
        unit: 'day',
        schedules,
      });

      expect(result.success).toBe(true);
      expect(result.deductedHours).toBe(8);
      expect(result.splitSegments.length).toBe(1);
      expect(result.splitSegments[0].durationHours).toBe(8);
    });

    it('应正确跳过节假日', () => {
      const schedules: WorkSchedule[] = [
        {
          employeeId: 'emp_001',
          date: '2025-01-02',
          shiftId: 'shift_standard',
          shift: standardShift,
        },
        {
          employeeId: 'emp_001',
          date: '2025-01-03',
          shiftId: 'shift_standard',
          shift: standardShift,
        },
      ];

      const result = engine.calculateLeave({
        employeeId: 'emp_001',
        leaveTypeCode: 'annual',
        startTime: '2025-01-01 09:00:00',
        endTime: '2025-01-03 18:00:00',
        unit: 'day',
        schedules,
      });

      expect(result.success).toBe(true);
      expect(result.tips.some((t) => t.includes('2025-01-01'))).toBe(true);
      expect(result.splitSegments.length).toBe(2);
    });

    it('应正确跳过周末', () => {
      const schedules: WorkSchedule[] = [
        {
          employeeId: 'emp_001',
          date: '2025-01-06',
          shiftId: 'shift_standard',
          shift: standardShift,
        },
        {
          employeeId: 'emp_001',
          date: '2025-01-07',
          shiftId: 'shift_standard',
          shift: standardShift,
        },
      ];

      const result = engine.calculateLeave({
        employeeId: 'emp_001',
        leaveTypeCode: 'annual',
        startTime: '2025-01-04 09:00:00',
        endTime: '2025-01-07 18:00:00',
        unit: 'day',
        schedules,
      });

      expect(result.splitSegments.length).toBe(2);
      expect(result.tips.some((t) => t.includes('周末'))).toBe(true);
    });

    it('应支持小时假', () => {
      const schedules: WorkSchedule[] = [
        {
          employeeId: 'emp_001',
          date: '2025-01-06',
          shiftId: 'shift_standard',
          shift: standardShift,
        },
      ];

      const result = engine.calculateLeave({
        employeeId: 'emp_001',
        leaveTypeCode: 'sick',
        startTime: '2025-01-06 09:00:00',
        endTime: '2025-01-06 11:00:00',
        unit: 'hour',
        schedules,
      });

      expect(result.success).toBe(true);
      expect(result.deductedHours).toBe(2);
    });
  });

  describe('请假申请', () => {
    beforeEach(() => {
      const balance: LeaveBalance = {
        employeeId: 'emp_001',
        leaveTypeCode: 'annual',
        totalHours: 80,
        usedHours: 0,
        frozenHours: 0,
      };
      engine.setLeaveBalance(balance);
    });

    it('应成功申请并自动扣减额度', () => {
      const schedules: WorkSchedule[] = [
        {
          employeeId: 'emp_001',
          date: '2025-01-06',
          shiftId: 'shift_standard',
          shift: standardShift,
        },
      ];

      const result = engine.applyLeave({
        employeeId: 'emp_001',
        leaveTypeCode: 'annual',
        startTime: '2025-01-06 09:00:00',
        endTime: '2025-01-06 18:00:00',
        unit: 'day',
        schedules,
        autoDeduct: true,
      });

      expect(result.success).toBe(true);
      expect(result.deduction?.success).toBe(true);
      expect(engine.getLeaveBalance('emp_001', 'annual')).toBe(72);
    });

    it('额度不足时申请失败', () => {
      const balance: LeaveBalance = {
        employeeId: 'emp_001',
        leaveTypeCode: 'annual',
        totalHours: 4,
        usedHours: 0,
        frozenHours: 0,
      };
      engine.setLeaveBalance(balance);

      const schedules: WorkSchedule[] = [
        {
          employeeId: 'emp_001',
          date: '2025-01-06',
          shiftId: 'shift_standard',
          shift: standardShift,
        },
      ];

      const result = engine.applyLeave({
        employeeId: 'emp_001',
        leaveTypeCode: 'annual',
        startTime: '2025-01-06 09:00:00',
        endTime: '2025-01-06 18:00:00',
        unit: 'day',
        schedules,
        autoDeduct: true,
      });

      expect(result.success).toBe(false);
      expect(result.calculation.insufficientBalance).toBe(true);
    });

    it('同员工同时段请假应检测到冲突', () => {
      const schedules: WorkSchedule[] = [
        {
          employeeId: 'emp_001',
          date: '2025-01-06',
          shiftId: 'shift_standard',
          shift: standardShift,
        },
      ];

      const existingLeaves = [
        {
          id: 'leave_001',
          employeeId: 'emp_001',
          leaveTypeCode: 'annual' as const,
          startTime: '2025-01-06 09:00:00',
          endTime: '2025-01-06 18:00:00',
          unit: 'day' as const,
          status: 'approved' as const,
          createdAt: '2025-01-01 00:00:00',
          createdBy: 'admin',
          deductedHours: 8,
        },
      ];

      const result = engine.applyLeave({
        employeeId: 'emp_001',
        leaveTypeCode: 'annual',
        startTime: '2025-01-06 09:00:00',
        endTime: '2025-01-06 18:00:00',
        unit: 'day',
        schedules,
        existingLeaves,
        autoDeduct: false,
      });

      expect(result.calculation.hasConflict).toBe(true);
    });

    it('不同员工同时段请假不应冲突', () => {
      const schedules: WorkSchedule[] = [
        {
          employeeId: 'emp_002',
          date: '2025-01-06',
          shiftId: 'shift_standard',
          shift: standardShift,
        },
      ];

      const existingLeaves = [
        {
          id: 'leave_001',
          employeeId: 'emp_001',
          leaveTypeCode: 'annual' as const,
          startTime: '2025-01-06 09:00:00',
          endTime: '2025-01-06 18:00:00',
          unit: 'day' as const,
          status: 'approved' as const,
          createdAt: '2025-01-01 00:00:00',
          createdBy: 'admin',
          deductedHours: 8,
        },
      ];

      const result = engine.applyLeave({
        employeeId: 'emp_002',
        leaveTypeCode: 'annual',
        startTime: '2025-01-06 09:00:00',
        endTime: '2025-01-06 18:00:00',
        unit: 'day',
        schedules,
        existingLeaves,
        autoDeduct: false,
      });

      expect(result.calculation.hasConflict).toBe(false);
    });

    it('修改自己原单时冲突检测排除原单', () => {
      const schedules: WorkSchedule[] = [
        {
          employeeId: 'emp_001',
          date: '2025-01-06',
          shiftId: 'shift_standard',
          shift: standardShift,
        },
      ];

      const existingLeaves = [
        {
          id: 'leave_001',
          employeeId: 'emp_001',
          leaveTypeCode: 'annual' as const,
          startTime: '2025-01-06 09:00:00',
          endTime: '2025-01-06 18:00:00',
          unit: 'day' as const,
          status: 'approved' as const,
          createdAt: '2025-01-01 00:00:00',
          createdBy: 'admin',
          deductedHours: 8,
        },
      ];

      const conflictResult = engine.checkConflicts({
        employeeId: 'emp_001',
        startTime: '2025-01-06 09:00:00',
        endTime: '2025-01-06 18:00:00',
        existingLeaves,
        excludeRequestId: 'leave_001',
      });

      expect(conflictResult.hasConflict).toBe(false);
      expect(conflictResult.conflicts.some((c) => c.type === 'self_modify')).toBe(true);
    });

    it('已撤销的单排除后不构成冲突', () => {
      const existingLeaves = [
        {
          id: 'leave_cancelled',
          employeeId: 'emp_001',
          leaveTypeCode: 'annual' as const,
          startTime: '2025-01-06 09:00:00',
          endTime: '2025-01-06 18:00:00',
          unit: 'day' as const,
          status: 'cancelled' as const,
          createdAt: '2025-01-01 00:00:00',
          createdBy: 'admin',
          deductedHours: 8,
        },
      ];

      const conflictResult = engine.checkConflicts({
        employeeId: 'emp_001',
        startTime: '2025-01-06 09:00:00',
        endTime: '2025-01-06 18:00:00',
        existingLeaves,
        excludeRequestId: 'leave_cancelled',
      });

      expect(conflictResult.hasConflict).toBe(false);
      expect(conflictResult.conflicts.some((c) => c.type === 'excluded_cancelled')).toBe(true);
    });
  });

  describe('请假撤销回滚', () => {
    it('应成功撤销并回滚额度', () => {
      const balance: LeaveBalance = {
        employeeId: 'emp_001',
        leaveTypeCode: 'annual',
        totalHours: 80,
        usedHours: 8,
        frozenHours: 0,
      };
      engine.setLeaveBalance(balance);

      const result = engine.cancelLeave({
        leaveRequest: {
          id: 'leave_001',
          employeeId: 'emp_001',
          leaveTypeCode: 'annual',
          startTime: '2025-01-06 09:00:00',
          endTime: '2025-01-06 18:00:00',
          unit: 'day',
          status: 'cancelled',
          createdAt: '2025-01-01 00:00:00',
          createdBy: 'admin',
          deductedHours: 8,
        },
        autoRollback: true,
      });

      expect(result.success).toBe(true);
      expect(result.rollback?.rolledBackHours).toBe(8);
      expect(engine.getLeaveBalance('emp_001', 'annual')).toBe(80);
    });
  });

  describe('调休余额核算', () => {
    it('应正确将加班转为调休', () => {
      const overtime: OvertimeRecord = {
        id: 'ot_001',
        employeeId: 'emp_001',
        date: '2025-01-04',
        startTime: '09:00',
        endTime: '17:00',
        durationHours: 8,
        convertedToCompensatory: false,
        approved: true,
      };
      engine.addOvertimeRecord(overtime);

      const result = engine.convertOvertimeToCompensatory('ot_001');
      expect(result.success).toBe(true);
      expect(result.convertedHours).toBe(8);
      expect(engine.getCompensatoryBalance('emp_001')).toBe(8);
    });

    it('未审批的加班不能转调休', () => {
      const overtime: OvertimeRecord = {
        id: 'ot_002',
        employeeId: 'emp_001',
        date: '2025-01-05',
        startTime: '09:00',
        endTime: '17:00',
        durationHours: 8,
        convertedToCompensatory: false,
        approved: false,
      };
      engine.addOvertimeRecord(overtime);

      const result = engine.convertOvertimeToCompensatory('ot_002');
      expect(result.success).toBe(false);
      expect(result.message).toContain('尚未审批');
    });

    it('支持分批转换：先转一部分后剩余加班时长还能继续转', () => {
      const overtime: OvertimeRecord = {
        id: 'ot_batch',
        employeeId: 'emp_001',
        date: '2025-01-04',
        startTime: '09:00',
        endTime: '21:00',
        durationHours: 12,
        convertedToCompensatory: false,
        approved: true,
      };
      engine.addOvertimeRecord(overtime);

      const result1 = engine.convertOvertimeToCompensatory('ot_batch', 5);
      expect(result1.success).toBe(true);
      expect(result1.convertedHours).toBe(5);
      expect(result1.remainingOvertimeHours).toBe(7);
      expect(result1.message).toContain('还剩 7 小时可继续转');
      expect(engine.getCompensatoryBalance('emp_001')).toBe(5);

      const result2 = engine.convertOvertimeToCompensatory('ot_batch', 4);
      expect(result2.success).toBe(true);
      expect(result2.convertedHours).toBe(4);
      expect(result2.remainingOvertimeHours).toBe(3);
      expect(engine.getCompensatoryBalance('emp_001')).toBe(9);

      const result3 = engine.convertOvertimeToCompensatory('ot_batch', 3);
      expect(result3.success).toBe(true);
      expect(result3.convertedHours).toBe(3);
      expect(result3.remainingOvertimeHours).toBe(0);
      expect(result3.message).toContain('已全部转完');
    });

    it('全部转完后再次尝试转换应明确拒绝', () => {
      const overtime: OvertimeRecord = {
        id: 'ot_full',
        employeeId: 'emp_001',
        date: '2025-01-04',
        startTime: '09:00',
        endTime: '17:00',
        durationHours: 8,
        convertedToCompensatory: false,
        approved: true,
      };
      engine.addOvertimeRecord(overtime);

      engine.convertOvertimeToCompensatory('ot_full');
      const result = engine.convertOvertimeToCompensatory('ot_full');
      expect(result.success).toBe(false);
      expect(result.message).toContain('已全部转为调休');
      expect(result.remainingOvertimeHours).toBe(0);
    });

    it('部分转换超过剩余时长应明确拒绝', () => {
      const overtime: OvertimeRecord = {
        id: 'ot_partial',
        employeeId: 'emp_001',
        date: '2025-01-04',
        startTime: '09:00',
        endTime: '17:00',
        durationHours: 8,
        convertedToCompensatory: false,
        approved: true,
      };
      engine.addOvertimeRecord(overtime);

      engine.convertOvertimeToCompensatory('ot_partial', 5);
      const result = engine.convertOvertimeToCompensatory('ot_partial', 5);
      expect(result.success).toBe(false);
      expect(result.message).toContain('超过');
      expect(result.remainingOvertimeHours).toBe(3);
    });
  });

  describe('迟到早退判断', () => {
    it('应判断正常打卡', () => {
      const schedule: WorkSchedule = {
        employeeId: 'emp_001',
        date: '2025-01-06',
        shiftId: 'shift_standard',
        shift: standardShift,
      };

      const punch: PunchRecord = {
        id: 'punch_001',
        employeeId: 'emp_001',
        date: '2025-01-06',
        checkIn: '08:55',
        checkOut: '18:05',
      };

      const result = engine.checkAttendance(schedule, punch);
      expect(result.status).toBe('normal');
      expect(result.isNormal).toBe(true);
      expect(result.lateMinutes).toBe(0);
      expect(result.earlyLeaveMinutes).toBe(0);
    });

    it('应判断迟到', () => {
      const schedule: WorkSchedule = {
        employeeId: 'emp_001',
        date: '2025-01-06',
        shiftId: 'shift_standard',
        shift: standardShift,
      };

      const punch: PunchRecord = {
        id: 'punch_002',
        employeeId: 'emp_001',
        date: '2025-01-06',
        checkIn: '09:15',
        checkOut: '18:00',
      };

      const result = engine.checkAttendance(schedule, punch);
      expect(result.status).toBe('late');
      expect(result.lateMinutes).toBe(10);
      expect(result.anomalyReasons.some((r) => r.includes('迟到'))).toBe(true);
    });

    it('应判断早退', () => {
      const schedule: WorkSchedule = {
        employeeId: 'emp_001',
        date: '2025-01-06',
        shiftId: 'shift_standard',
        shift: standardShift,
      };

      const punch: PunchRecord = {
        id: 'punch_003',
        employeeId: 'emp_001',
        date: '2025-01-06',
        checkIn: '09:00',
        checkOut: '17:30',
      };

      const result = engine.checkAttendance(schedule, punch);
      expect(result.status).toBe('early_leave');
      expect(result.earlyLeaveMinutes).toBe(25);
    });

    it('应标记未打卡异常', () => {
      const schedule: WorkSchedule = {
        employeeId: 'emp_001',
        date: '2025-01-06',
        shiftId: 'shift_standard',
        shift: standardShift,
      };

      const result = engine.checkAttendance(schedule);
      expect(result.status).toBe('absent');
      expect(result.anomalyReasons.some((r) => r.includes('未打卡'))).toBe(true);
    });

    it('宽限期内不算迟到', () => {
      const schedule: WorkSchedule = {
        employeeId: 'emp_001',
        date: '2025-01-06',
        shiftId: 'shift_standard',
        shift: standardShift,
      };

      const punch: PunchRecord = {
        id: 'punch_004',
        employeeId: 'emp_001',
        date: '2025-01-06',
        checkIn: '09:03',
        checkOut: '18:00',
      };

      const result = engine.checkAttendance(schedule, punch);
      expect(result.status).toBe('normal');
      expect(result.lateMinutes).toBe(0);
    });
  });

  describe('部分假+考勤', () => {
    it('全天假正常标记为请假', () => {
      const schedule: WorkSchedule = {
        employeeId: 'emp_001',
        date: '2025-01-06',
        shiftId: 'shift_standard',
        shift: standardShift,
      };

      const leaves = [
        {
          id: 'leave_full',
          employeeId: 'emp_001',
          leaveTypeCode: 'annual' as const,
          startTime: '2025-01-06 09:00:00',
          endTime: '2025-01-06 18:00:00',
          unit: 'day' as const,
          status: 'approved' as const,
          createdAt: '2025-01-01 00:00:00',
          createdBy: 'admin',
          deductedHours: 8,
        },
      ];

      const result = engine.checkAttendance(schedule, undefined, leaves);
      expect(result.status).toBe('leave');
      expect(result.leaveHours).toBe(8);
      expect(result.nonLeaveRequiredHours).toBe(0);
    });

    it('半天假+无打卡应标记缺勤并提示剩余时段未打卡', () => {
      const schedule: WorkSchedule = {
        employeeId: 'emp_001',
        date: '2025-01-06',
        shiftId: 'shift_standard',
        shift: standardShift,
      };

      const leaves = [
        {
          id: 'leave_am',
          employeeId: 'emp_001',
          leaveTypeCode: 'annual' as const,
          startTime: '2025-01-06 09:00:00',
          endTime: '2025-01-06 13:00:00',
          unit: 'half_day' as const,
          status: 'approved' as const,
          createdAt: '2025-01-01 00:00:00',
          createdBy: 'admin',
          deductedHours: 4,
        },
      ];

      const result = engine.checkAttendance(schedule, undefined, leaves);
      expect(result.status).toBe('absent');
      expect(result.leaveHours).toBeGreaterThan(0);
      expect(result.anomalyReasons.some((r) => r.includes('未打卡'))).toBe(true);
    });

    it('半天假+正常打卡下半天应正常', () => {
      const schedule: WorkSchedule = {
        employeeId: 'emp_001',
        date: '2025-01-06',
        shiftId: 'shift_standard',
        shift: standardShift,
      };

      const leaves = [
        {
          id: 'leave_am2',
          employeeId: 'emp_001',
          leaveTypeCode: 'annual' as const,
          startTime: '2025-01-06 09:00:00',
          endTime: '2025-01-06 13:00:00',
          unit: 'half_day' as const,
          status: 'approved' as const,
          createdAt: '2025-01-01 00:00:00',
          createdBy: 'admin',
          deductedHours: 4,
        },
      ];

      const punch: PunchRecord = {
        id: 'punch_half',
        employeeId: 'emp_001',
        date: '2025-01-06',
        checkIn: '13:00',
        checkOut: '18:00',
      };

      const result = engine.checkAttendance(schedule, punch, leaves);
      expect(result.leaveHours).toBeGreaterThan(0);
      expect(result.workHours).toBeGreaterThan(0);
      expect(result.isNormal).toBe(true);
    });

    it('半天假+只打上班卡应标记异常', () => {
      const schedule: WorkSchedule = {
        employeeId: 'emp_001',
        date: '2025-01-06',
        shiftId: 'shift_standard',
        shift: standardShift,
      };

      const leaves = [
        {
          id: 'leave_pm',
          employeeId: 'emp_001',
          leaveTypeCode: 'annual' as const,
          startTime: '2025-01-06 13:00:00',
          endTime: '2025-01-06 18:00:00',
          unit: 'half_day' as const,
          status: 'approved' as const,
          createdAt: '2025-01-01 00:00:00',
          createdBy: 'admin',
          deductedHours: 4,
        },
      ];

      const punch: PunchRecord = {
        id: 'punch_half2',
        employeeId: 'emp_001',
        date: '2025-01-06',
        checkIn: '09:00',
        checkOut: undefined,
      };

      const result = engine.checkAttendance(schedule, punch, leaves);
      expect(result.status).toBe('absent');
      expect(result.anomalyReasons.some((r) => r.includes('缺下班打卡'))).toBe(true);
    });

    it('小时假+剩余时间迟到应标记', () => {
      const schedule: WorkSchedule = {
        employeeId: 'emp_001',
        date: '2025-01-06',
        shiftId: 'shift_standard',
        shift: standardShift,
      };

      const leaves = [
        {
          id: 'leave_hour',
          employeeId: 'emp_001',
          leaveTypeCode: 'sick' as const,
          startTime: '2025-01-06 09:00:00',
          endTime: '2025-01-06 10:00:00',
          unit: 'hour' as const,
          status: 'approved' as const,
          createdAt: '2025-01-01 00:00:00',
          createdBy: 'admin',
          deductedHours: 1,
        },
      ];

      const punch: PunchRecord = {
        id: 'punch_hour',
        employeeId: 'emp_001',
        date: '2025-01-06',
        checkIn: '10:15',
        checkOut: '18:00',
      };

      const result = engine.checkAttendance(schedule, punch, leaves);
      expect(result.lateMinutes).toBeGreaterThan(0);
      expect(result.anomalyReasons.some((r) => r.includes('非请假时段迟到'))).toBe(true);
    });
  });

  describe('月度假勤摘要', () => {
    it('应正确生成月度摘要', () => {
      const schedules: WorkSchedule[] = [];
      const punches: PunchRecord[] = [];

      for (let day = 1; day <= 10; day++) {
        const dateStr = `2025-01-${String(day).padStart(2, '0')}`;
        const date = new Date(dateStr);
        const dayOfWeek = date.getDay();
        const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
        const isHoliday = engine.isHoliday(dateStr);

        schedules.push({
          employeeId: 'emp_001',
          date: dateStr,
          shiftId: 'shift_standard',
          shift: standardShift,
          isRestDay: isWeekend || isHoliday,
          isHoliday,
        });

        if (!isWeekend && !isHoliday) {
          punches.push({
            id: `punch_${day}`,
            employeeId: 'emp_001',
            date: dateStr,
            checkIn: '09:00',
            checkOut: '18:00',
          });
        }
      }

      const summary = engine.generateMonthlySummary({
        employeeId: 'emp_001',
        year: 2025,
        month: 1,
        schedules,
        punches,
        leaves: [],
        overtimes: [],
        leaveTypes: [annualLeaveType, sickLeaveType, compensatoryLeaveType],
      });

      expect(summary.employeeId).toBe('emp_001');
      expect(summary.totalWorkDays).toBeGreaterThan(0);
      expect(summary.lateCount).toBe(0);
    });

    it('同一天既迟到又早退时两边次数和分钟数都要统计', () => {
      const schedule: WorkSchedule = {
        employeeId: 'emp_001',
        date: '2025-01-06',
        shiftId: 'shift_standard',
        shift: standardShift,
      };

      const punch: PunchRecord = {
        id: 'punch_both',
        employeeId: 'emp_001',
        date: '2025-01-06',
        checkIn: '09:20',
        checkOut: '17:30',
      };

      const result = engine.checkAttendance(schedule, punch);
      expect(result.lateMinutes).toBeGreaterThan(0);
      expect(result.earlyLeaveMinutes).toBeGreaterThan(0);

      const summary = engine.generateMonthlySummary({
        employeeId: 'emp_001',
        year: 2025,
        month: 1,
        schedules: [schedule],
        punches: [punch],
        leaves: [],
        overtimes: [],
        leaveTypes: [annualLeaveType, sickLeaveType, compensatoryLeaveType],
      });

      expect(summary.lateCount).toBe(1);
      expect(summary.lateTotalMinutes).toBeGreaterThan(0);
      expect(summary.earlyLeaveCount).toBe(1);
      expect(summary.earlyLeaveTotalMinutes).toBeGreaterThan(0);
    });

    it('无排班无打卡不算实际出勤', () => {
      const summary = engine.generateMonthlySummary({
        employeeId: 'emp_001',
        year: 2025,
        month: 1,
        schedules: [],
        punches: [],
        leaves: [],
        overtimes: [],
        leaveTypes: [annualLeaveType, sickLeaveType, compensatoryLeaveType],
      });

      expect(summary.totalWorkDays).toBe(0);
      expect(summary.actualWorkDays).toBe(0);
      expect(summary.actualWorkHours).toBe(0);
    });

    it('部分排班数据不虚增出勤天数', () => {
      const schedules: WorkSchedule[] = [
        {
          employeeId: 'emp_001',
          date: '2025-01-06',
          shiftId: 'shift_standard',
          shift: standardShift,
        },
        {
          employeeId: 'emp_001',
          date: '2025-01-07',
          shiftId: 'shift_standard',
          shift: standardShift,
        },
      ];

      const punches: PunchRecord[] = [
        {
          id: 'punch_6',
          employeeId: 'emp_001',
          date: '2025-01-06',
          checkIn: '09:00',
          checkOut: '18:00',
        },
      ];

      const summary = engine.generateMonthlySummary({
        employeeId: 'emp_001',
        year: 2025,
        month: 1,
        schedules,
        punches,
        leaves: [],
        overtimes: [],
        leaveTypes: [annualLeaveType, sickLeaveType, compensatoryLeaveType],
      });

      expect(summary.totalWorkDays).toBe(2);
      expect(summary.actualWorkDays).toBe(1);
    });
  });

  describe('批量请假申请', () => {
    it('按员工分组返回，单人失败不影响其他人', () => {
      const schedules1: WorkSchedule[] = [
        { employeeId: 'emp_a', date: '2025-01-06', shiftId: 'shift_standard', shift: standardShift },
        { employeeId: 'emp_a', date: '2025-01-07', shiftId: 'shift_standard', shift: standardShift },
      ];
      const schedules2: WorkSchedule[] = [
        { employeeId: 'emp_b', date: '2025-01-06', shiftId: 'shift_standard', shift: standardShift },
      ];

      engine.setLeaveBalances([
        { employeeId: 'emp_a', leaveTypeCode: 'annual', totalHours: 80, usedHours: 0, frozenHours: 0 },
        { employeeId: 'emp_b', leaveTypeCode: 'annual', totalHours: 4, usedHours: 0, frozenHours: 0 },
      ]);

      const batchResult = engine.applyLeaveBatch({
        requests: [
          {
            employeeId: 'emp_a',
            leaveTypeCode: 'annual',
            startTime: '2025-01-06 09:00:00',
            endTime: '2025-01-07 18:00:00',
            unit: 'day',
            schedules: schedules1,
            autoDeduct: true,
          },
          {
            employeeId: 'emp_b',
            leaveTypeCode: 'annual',
            startTime: '2025-01-06 09:00:00',
            endTime: '2025-01-06 18:00:00',
            unit: 'day',
            schedules: schedules2,
            autoDeduct: true,
          },
        ],
      });

      expect(batchResult.summary.totalCount).toBe(2);
      expect(batchResult.summary.successCount).toBe(1);
      expect(batchResult.summary.failedCount).toBe(1);
      expect(batchResult.summary.insufficientBalanceCount).toBe(1);
      expect(batchResult.resultsByEmployee['emp_a'].length).toBe(1);
      expect(batchResult.resultsByEmployee['emp_a'][0].success).toBe(true);
      expect(batchResult.resultsByEmployee['emp_b'].length).toBe(1);
      expect(batchResult.resultsByEmployee['emp_b'][0].success).toBe(false);
      expect(batchResult.success).toBe(false);
    });

    it('批量请假中不同员工同一时段不互扰', () => {
      const schedulesA: WorkSchedule[] = [
        { employeeId: 'emp_a', date: '2025-01-08', shiftId: 'shift_standard', shift: standardShift },
      ];
      const schedulesB: WorkSchedule[] = [
        { employeeId: 'emp_b', date: '2025-01-08', shiftId: 'shift_standard', shift: standardShift },
      ];

      engine.setLeaveBalances([
        { employeeId: 'emp_a', leaveTypeCode: 'annual', totalHours: 40, usedHours: 0, frozenHours: 0 },
        { employeeId: 'emp_b', leaveTypeCode: 'annual', totalHours: 40, usedHours: 0, frozenHours: 0 },
      ]);

      const existingA = [
        {
          id: 'exist_a',
          employeeId: 'emp_a',
          leaveTypeCode: 'annual' as const,
          startTime: '2025-01-08 09:00:00',
          endTime: '2025-01-08 12:00:00',
          unit: 'half_day' as const,
          status: 'approved' as const,
          createdAt: '2025-01-01',
          createdBy: 'admin',
        },
      ];

      const batchResult = engine.applyLeaveBatch({
        requests: [
          {
            employeeId: 'emp_a',
            leaveTypeCode: 'annual',
            startTime: '2025-01-08 13:00:00',
            endTime: '2025-01-08 18:00:00',
            unit: 'half_day',
            schedules: schedulesA,
            existingLeaves: existingA,
          },
          {
            employeeId: 'emp_b',
            leaveTypeCode: 'annual',
            startTime: '2025-01-08 09:00:00',
            endTime: '2025-01-08 18:00:00',
            unit: 'day',
            schedules: schedulesB,
            existingLeaves: existingA,
          },
        ],
      });

      expect(batchResult.summary.failedCount).toBe(0);
      expect(batchResult.resultsByEmployee['emp_a'][0].calculation.hasConflict).toBe(false);
      expect(batchResult.resultsByEmployee['emp_b'][0].calculation.hasConflict).toBe(false);
    });
  });

  describe('部分假考勤时长对齐', () => {
    it('上午假接下午出勤：请假+剩余需出勤=班次总工时', () => {
      const schedule: WorkSchedule = {
        employeeId: 'emp_001',
        date: '2025-01-06',
        shiftId: 'shift_standard',
        shift: standardShift,
      };

      const leaves = [
        {
          id: 'leave_am',
          employeeId: 'emp_001',
          leaveTypeCode: 'sick' as const,
          startTime: '2025-01-06 09:00:00',
          endTime: '2025-01-06 13:00:00',
          unit: 'half_day' as const,
          status: 'approved' as const,
          createdAt: '2025-01-01',
          createdBy: 'admin',
          deductedHours: 4,
        },
      ];

      const punch: PunchRecord = {
        id: 'punch_1',
        employeeId: 'emp_001',
        date: '2025-01-06',
        checkIn: '13:00',
        checkOut: '18:00',
      };

      const result = engine.checkAttendance(schedule, punch, leaves);
      expect(result.leaveHours + result.nonLeaveRequiredHours).toBeCloseTo(8, 1);
    });

    it('跨午休：请假时长扣除午休后正确对齐', () => {
      const schedule: WorkSchedule = {
        employeeId: 'emp_001',
        date: '2025-01-06',
        shiftId: 'shift_standard',
        shift: standardShift,
      };

      const leaves = [
        {
          id: 'leave_noon',
          employeeId: 'emp_001',
          leaveTypeCode: 'sick' as const,
          startTime: '2025-01-06 11:00:00',
          endTime: '2025-01-06 14:00:00',
          unit: 'hour' as const,
          status: 'approved' as const,
          createdAt: '2025-01-01',
          createdBy: 'admin',
          deductedHours: 2,
        },
      ];

      const punch: PunchRecord = {
        id: 'punch_2',
        employeeId: 'emp_001',
        date: '2025-01-06',
        checkIn: '09:00',
        checkOut: '18:00',
      };

      const result = engine.checkAttendance(schedule, punch, leaves);
      expect(result.leaveHours).toBe(2);
      expect(result.leaveHours + result.nonLeaveRequiredHours).toBeCloseTo(8, 1);
    });
  });

  describe('调休转换边界加固', () => {
    beforeEach(() => {
      engine.addOvertimeRecord({
        id: 'ot_boundary',
        employeeId: 'emp_001',
        date: '2025-01-05',
        startTime: '18:00',
        endTime: '22:00',
        durationHours: 4,
        reason: '周末加班',
        convertedToCompensatory: false,
        approved: true,
      });
    });

    it('传 0 小时明确失败且不改余额', () => {
      const beforeBalance = engine.getCompensatoryBalance('emp_001');
      const result = engine.convertOvertimeToCompensatory('ot_boundary', 0);

      expect(result.success).toBe(false);
      expect(result.convertedHours).toBe(0);
      expect(result.message).toContain('必须大于0');
      expect(engine.getCompensatoryBalance('emp_001')).toBe(beforeBalance);
      expect(result.beforeConvertedHours).toBe(0);
      expect(result.afterConvertedHours).toBe(0);
    });

    it('超过剩余时长明确失败', () => {
      const beforeBalance = engine.getCompensatoryBalance('emp_001');
      const result = engine.convertOvertimeToCompensatory('ot_boundary', 10);

      expect(result.success).toBe(false);
      expect(result.message).toContain('超过');
      expect(engine.getCompensatoryBalance('emp_001')).toBe(beforeBalance);
    });

    it('分批转换时返回清晰：本次转多少、还剩多少', () => {
      const r1 = engine.convertOvertimeToCompensatory('ot_boundary', 1.5, 0.5);
      expect(r1.success).toBe(true);
      expect(r1.convertedHours).toBe(1.5);
      expect(r1.beforeConvertedHours).toBe(0);
      expect(r1.afterConvertedHours).toBe(1.5);
      expect(r1.remainingOvertimeHours).toBe(2.5);

      const r2 = engine.convertOvertimeToCompensatory('ot_boundary', 2.5, 0.5);
      expect(r2.success).toBe(true);
      expect(r2.beforeConvertedHours).toBe(1.5);
      expect(r2.afterConvertedHours).toBe(4);
      expect(r2.remainingOvertimeHours).toBe(0);
      expect(r2.message).toContain('已全部转完');
    });

    it('非最小单位整数倍明确失败', () => {
      const beforeBalance = engine.getCompensatoryBalance('emp_001');
      const result = engine.convertOvertimeToCompensatory('ot_boundary', 0.3, 0.5);

      expect(result.success).toBe(false);
      expect(result.message).toContain('最小单位');
      expect(engine.getCompensatoryBalance('emp_001')).toBe(beforeBalance);
    });
  });

  describe('批量月度摘要', () => {
    it('多员工数据隔离，部门汇总累加', () => {
      const schedulesA: WorkSchedule[] = [];
      const punchesA: PunchRecord[] = [];
      const schedulesB: WorkSchedule[] = [];
      const punchesB: PunchRecord[] = [];

      for (let day = 6; day <= 7; day++) {
        const dateStr = `2025-01-${String(day).padStart(2, '0')}`;
        schedulesA.push({ employeeId: 'emp_a', date: dateStr, shiftId: 'shift_standard', shift: standardShift });
        punchesA.push({ id: `pa${day}`, employeeId: 'emp_a', date: dateStr, checkIn: '09:00', checkOut: '18:00' });

        schedulesB.push({ employeeId: 'emp_b', date: dateStr, shiftId: 'shift_standard', shift: standardShift });
        punchesB.push({ id: `pb${day}`, employeeId: 'emp_b', date: dateStr, checkIn: '09:00', checkOut: '18:00' });
      }

      const batch = engine.generateMonthlySummaryBatch({
        items: [
          {
            employee: { id: 'emp_a', name: '员工A', department: '研发部' },
            params: {
              employeeId: 'emp_a',
              year: 2025,
              month: 1,
              schedules: schedulesA,
              punches: punchesA,
              leaves: [],
              overtimes: [],
              leaveTypes: [annualLeaveType, sickLeaveType, compensatoryLeaveType],
            },
          },
          {
            employee: { id: 'emp_b', name: '员工B', department: '研发部' },
            params: {
              employeeId: 'emp_b',
              year: 2025,
              month: 1,
              schedules: schedulesB,
              punches: punchesB,
              leaves: [],
              overtimes: [],
              leaveTypes: [annualLeaveType, sickLeaveType, compensatoryLeaveType],
            },
          },
        ],
      });

      expect(batch.summaries['emp_a']).toBeDefined();
      expect(batch.summaries['emp_b']).toBeDefined();
      expect(batch.summaries['emp_a'].employeeId).toBe('emp_a');
      expect(batch.summaries['emp_b'].employeeId).toBe('emp_b');

      expect(batch.byDepartment['研发部']).toBeDefined();
      expect(batch.byDepartment['研发部'].employeeCount).toBe(2);
      expect(batch.byDepartment['研发部'].totalActualWorkDays).toBe(4);

      expect(batch.overallSummary.employeeCount).toBe(2);
      expect(batch.overallSummary.totalActualWorkDays).toBe(4);
    });

    it('部门整包模式：混合传入多员工数据，按员工自动拆分', () => {
      const schedules: WorkSchedule[] = [];
      const punches: PunchRecord[] = [];

      for (let day = 6; day <= 7; day++) {
        const dateStr = `2025-01-${String(day).padStart(2, '0')}`;
        schedules.push(
          { employeeId: 'emp_a', date: dateStr, shiftId: 'shift_standard', shift: standardShift },
          { employeeId: 'emp_b', date: dateStr, shiftId: 'shift_standard', shift: standardShift }
        );
        punches.push(
          { id: `pa${day}`, employeeId: 'emp_a', date: dateStr, checkIn: '09:00', checkOut: '18:00' },
          { id: `pb${day}`, employeeId: 'emp_b', date: dateStr, checkIn: '09:00', checkOut: '18:00' }
        );
      }

      const leaves: LeaveRequest[] = [];
      const overtimes: OvertimeRecord[] = [];

      const deptBatch = engine.generateDepartmentMonthlySummaryBatch({
        year: 2025,
        month: 1,
        employees: [
          { id: 'emp_a', name: '员工A', department: '研发部' },
          { id: 'emp_b', name: '员工B', department: '研发部' },
        ],
        schedules,
        punches,
        leaves,
        overtimes,
        leaveTypes: [annualLeaveType, sickLeaveType, compensatoryLeaveType],
      });

      expect(deptBatch.summaries['emp_a']).toBeDefined();
      expect(deptBatch.summaries['emp_b']).toBeDefined();
      expect(deptBatch.byDepartment['研发部']).toBeDefined();
      expect(deptBatch.byDepartment['研发部'].employeeCount).toBe(2);
      expect(deptBatch.overallSummary.employeeCount).toBe(2);
      expect(deptBatch.summaries['emp_a'].actualWorkDays).toBe(2);
      expect(deptBatch.summaries['emp_b'].actualWorkDays).toBe(2);
    });
  });

  describe('批量试算模式', () => {
    it('preview=true 不扣余额，返回口径与提交一致', () => {
      engine.setLeaveBalances([
        { employeeId: 'emp_001', leaveTypeCode: 'annual', totalHours: 40, usedHours: 0, frozenHours: 0 },
      ]);

      const schedules: WorkSchedule[] = [
        { employeeId: 'emp_001', date: '2025-01-06', shiftId: 'shift_standard', shift: standardShift },
      ];

      const beforeBalance = engine.getLeaveBalance('emp_001', 'annual');

      const batch = engine.applyLeaveBatch({
        requests: [{
          employeeId: 'emp_001',
          leaveTypeCode: 'annual',
          startTime: '2025-01-06 09:00:00',
          endTime: '2025-01-06 18:00:00',
          unit: 'day',
          schedules,
          autoDeduct: true,
        }],
        preview: true,
      });

      expect(batch.resultsByEmployee['emp_001'][0].success).toBe(true);
      expect(batch.resultsByEmployee['emp_001'][0].tips).toContain('【试算模式】未扣减额度');
      expect(batch.resultsByEmployee['emp_001'][0].calculation.deductedHours).toBe(8);
      expect(batch.resultsByEmployee['emp_001'][0].deduction).toBeUndefined();

      const afterBalance = engine.getLeaveBalance('emp_001', 'annual');
      expect(afterBalance).toBe(beforeBalance);
    });

    it('preview=false 正常扣余额', () => {
      engine.setLeaveBalances([
        { employeeId: 'emp_001', leaveTypeCode: 'annual', totalHours: 40, usedHours: 0, frozenHours: 0 },
      ]);
      const schedules: WorkSchedule[] = [
        { employeeId: 'emp_001', date: '2025-01-07', shiftId: 'shift_standard', shift: standardShift },
      ];

      const beforeBalance = engine.getLeaveBalance('emp_001', 'annual');

      const batch = engine.applyLeaveBatch({
        requests: [{
          employeeId: 'emp_001',
          leaveTypeCode: 'annual',
          startTime: '2025-01-07 09:00:00',
          endTime: '2025-01-07 18:00:00',
          unit: 'day',
          schedules,
          autoDeduct: true,
        }],
        preview: false,
      });

      expect(batch.resultsByEmployee['emp_001'][0].success).toBe(true);
      expect(batch.resultsByEmployee['emp_001'][0].deduction).toBeDefined();
      expect(batch.resultsByEmployee['emp_001'][0].deduction?.success).toBe(true);

      const afterBalance = engine.getLeaveBalance('emp_001', 'annual');
      expect(afterBalance).toBe(beforeBalance - 8);
    });
  });

  describe('夜班完整规则', () => {
    const nightShift: Shift = {
      id: 'night',
      name: '夜班',
      startTime: '22:00',
      endTime: '06:00',
      restStartTime: '00:00',
      restEndTime: '01:00',
      lateGraceMinutes: 0,
      earlyLeaveGraceMinutes: 0,
      workDays: [1, 2, 3, 4, 5],
    };

    it('夜班跨凌晨：请假+剩余需出勤=班次总工时', () => {
      const schedule: WorkSchedule = {
        employeeId: 'emp_001',
        date: '2025-01-06',
        shiftId: 'night',
        shift: nightShift,
      };

      const leaves = [
        {
          id: 'leave_night',
          employeeId: 'emp_001',
          leaveTypeCode: 'sick' as const,
          startTime: '2025-01-06 22:00:00',
          endTime: '2025-01-07 04:00:00',
          unit: 'hour' as const,
          status: 'approved' as const,
          createdAt: '2025-01-01',
          createdBy: 'admin',
          deductedHours: 5,
        },
      ];

      const punch: PunchRecord = {
        id: 'punch_night',
        employeeId: 'emp_001',
        date: '2025-01-06',
        checkIn: '04:00',
        checkOut: '06:00',
      };

      const result = engine.checkAttendance(schedule, punch, leaves);
      const shiftHours = engine.calculateShiftHours(nightShift);

      expect(result.leaveHours + result.nonLeaveRequiredHours).toBeCloseTo(shiftHours.workHours, 1);
      expect(result.leaveHours).toBe(5);
      expect(result.nonLeaveRequiredHours).toBe(2);
      expect(result.leaveHours + result.nonLeaveRequiredHours).toBe(7);
    });

    it('夜班凌晨打卡跨天归属正确，迟到早退正常计算', () => {
      const schedule: WorkSchedule = {
        employeeId: 'emp_001',
        date: '2025-01-06',
        shiftId: 'night',
        shift: nightShift,
      };

      const punch: PunchRecord = {
        id: 'punch_night_late',
        employeeId: 'emp_001',
        date: '2025-01-06',
        checkIn: '22:30',
        checkOut: '05:30',
      };

      const result = engine.checkAttendance(schedule, punch, []);
      expect(result.lateMinutes).toBe(30);
      expect(result.earlyLeaveMinutes).toBe(30);
      expect(result.status).toBe('late');
    });

    it('夜班中间休息段跨凌晨被正确扣除', () => {
      const shiftHours = engine.calculateShiftHours(nightShift);
      expect(shiftHours.workHours).toBe(7);
      expect(shiftHours.totalHours).toBe(8);
    });
  });

  describe('跨午休但没请整天', () => {
    it('请到下班前1小时，正确显示剩余1小时需出勤', () => {
      const schedule: WorkSchedule = {
        employeeId: 'emp_001',
        date: '2025-01-06',
        shiftId: 'shift_standard',
        shift: standardShift,
      };

      const leaves = [
        {
          id: 'leave_before_end',
          employeeId: 'emp_001',
          leaveTypeCode: 'sick' as const,
          startTime: '2025-01-06 09:00:00',
          endTime: '2025-01-06 17:00:00',
          unit: 'hour' as const,
          status: 'approved' as const,
          createdAt: '2025-01-01',
          createdBy: 'admin',
        },
      ];

      const punch: PunchRecord = {
        id: 'punch_2',
        employeeId: 'emp_001',
        date: '2025-01-06',
        checkIn: '17:00',
        checkOut: '18:00',
      };

      const result = engine.checkAttendance(schedule, punch, leaves);
      expect(result.leaveHours + result.nonLeaveRequiredHours).toBeCloseTo(8, 1);
      expect(result.leaveHours).toBe(7);
      expect(result.nonLeaveRequiredHours).toBe(1);
      expect(result.status).not.toBe('leave');
      expect(result.status).toBe('normal');
    });

    it('跨午休部分请假，不会误判为全天假', () => {
      const schedule: WorkSchedule = {
        employeeId: 'emp_001',
        date: '2025-01-06',
        shiftId: 'shift_standard',
        shift: standardShift,
      };

      const leaves = [
        {
          id: 'leave_across_noon',
          employeeId: 'emp_001',
          leaveTypeCode: 'sick' as const,
          startTime: '2025-01-06 11:00:00',
          endTime: '2025-01-06 14:00:00',
          unit: 'hour' as const,
          status: 'approved' as const,
          createdAt: '2025-01-01',
          createdBy: 'admin',
        },
      ];

      const punch: PunchRecord = {
        id: 'punch_3',
        employeeId: 'emp_001',
        date: '2025-01-06',
        checkIn: '09:00',
        checkOut: '18:00',
      };

      const result = engine.checkAttendance(schedule, punch, leaves);
      expect(result.leaveHours).toBe(2);
      expect(result.leaveHours + result.nonLeaveRequiredHours).toBeCloseTo(8, 1);
      expect(result.status).toBe('normal');
      expect(result.workHours).toBeCloseTo(6, 1);
    });
  });

  describe('第五轮边界加固', () => {
    const nightShift: Shift = {
      id: 'shift_night',
      name: '夜班',
      startTime: '22:00',
      endTime: '06:00',
      restStartTime: '00:00',
      restEndTime: '01:00',
      lateGraceMinutes: 5,
      earlyLeaveGraceMinutes: 5,
      workDays: [1, 2, 3, 4, 5],
    };

    beforeEach(() => {
      engine = new AttendanceRuleEngine({
        shifts: [standardShift, nightShift],
        leaveTypes: [annualLeaveType, sickLeaveType, compensatoryLeaveType],
      });
    });

    it('夜班凌晨请假自动归属到前一天的夜班，无需传两天排班', () => {
      engine.setLeaveBalances([
        { employeeId: 'emp_night', leaveTypeCode: 'annual', totalHours: 40, usedHours: 0, frozenHours: 0 },
      ]);

      const result = engine.applyLeave({
        employeeId: 'emp_night',
        leaveTypeCode: 'annual',
        startTime: '2025-01-07 01:00:00',
        endTime: '2025-01-07 03:00:00',
        unit: 'hour',
        schedules: [
          { employeeId: 'emp_night', date: '2025-01-06', shiftId: 'shift_night', shift: nightShift },
        ],
        autoDeduct: false,
      });

      expect(result.calculation.success).toBe(true);
      expect(result.calculation.splitSegments.length).toBeGreaterThan(0);
      const seg = result.calculation.splitSegments.find(s => s.durationHours > 0);
      expect(seg).toBeDefined();
      expect(seg?.date).toBe('2025-01-06');
      expect(seg?.durationHours).toBe(2);
      expect(result.calculation.deductedHours).toBe(2);
    });

    it('批量试算同员工多申请按顺序占用额度，提示合计超额', () => {
      engine.setLeaveBalances([
        { employeeId: 'emp_preview', leaveTypeCode: 'annual', totalHours: 16, usedHours: 0, frozenHours: 0 },
      ]);

      const commonSchedule = {
        employeeId: 'emp_preview',
        date: '2025-01-06',
        shiftId: 'shift_standard',
        shift: standardShift,
      };

      const result = engine.applyLeaveBatch({
        preview: true,
        requests: [
          {
            employeeId: 'emp_preview',
            leaveTypeCode: 'annual',
            startTime: '2025-01-06 09:00:00',
            endTime: '2025-01-06 18:00:00',
            unit: 'day',
            schedules: [commonSchedule],
            autoDeduct: false,
            excludeRequestId: 'r1',
          },
          {
            employeeId: 'emp_preview',
            leaveTypeCode: 'annual',
            startTime: '2025-01-07 09:00:00',
            endTime: '2025-01-07 18:00:00',
            unit: 'day',
            schedules: [{ ...commonSchedule, date: '2025-01-07' }],
            autoDeduct: false,
            excludeRequestId: 'r2',
          },
          {
            employeeId: 'emp_preview',
            leaveTypeCode: 'annual',
            startTime: '2025-01-08 09:00:00',
            endTime: '2025-01-08 18:00:00',
            unit: 'day',
            schedules: [{ ...commonSchedule, date: '2025-01-08' }],
            autoDeduct: false,
            excludeRequestId: 'r3',
          },
        ],
      });

      expect(result.summary.totalCount).toBe(3);
      expect(result.summary.successCount).toBe(2);
      expect(result.summary.failedCount).toBe(1);
      expect(result.summary.insufficientBalanceCount).toBe(1);

      const r1 = result.resultsByEmployee['emp_preview'].find(r => r.requestId === 'r1');
      const r2 = result.resultsByEmployee['emp_preview'].find(r => r.requestId === 'r2');
      const r3 = result.resultsByEmployee['emp_preview'].find(r => r.requestId === 'r3');

      expect(r1?.success).toBe(true);
      expect(r2?.success).toBe(true);
      expect(r3?.success).toBe(false);
      expect(r3?.calculation.insufficientBalance).toBe(true);
      expect(r3?.tips?.some(t => t.includes('超额'))).toBe(true);
      expect(engine.getLeaveBalance('emp_preview', 'annual')).toBe(16);
    });

    it('夜班实际工时扣除休息段后与早退分钟对齐', () => {
      const schedule: WorkSchedule = {
        employeeId: 'emp_actual',
        date: '2025-01-06',
        shiftId: 'shift_night',
        shift: nightShift,
      };

      const punch: PunchRecord = {
        id: 'punch_night',
        employeeId: 'emp_actual',
        date: '2025-01-06',
        checkIn: '22:00',
        checkOut: '04:00',
      };

      const result = engine.checkAttendance(schedule, punch, []);

      expect(result.status).toBe('early_leave');
      expect(result.earlyLeaveMinutes).toBe(115);

      const shiftHours = engine.calculateShiftHours(nightShift);
      const expectedWorkHours = (shiftHours.workMinutes - result.earlyLeaveMinutes) / 60;
      expect(result.workHours).toBeCloseTo(expectedWorkHours, 1);

      expect(result.workHours + result.leaveHours + result.nonLeaveRequiredHours * 0 + (result.earlyLeaveMinutes) / 60 + (result.lateMinutes) / 60)
        .toBeCloseTo(shiftHours.workHours, 1);
    });

    it('月报异常明细包含每日迟到早退缺卡和部分假剩余', () => {
      const schedules: WorkSchedule[] = [
        { employeeId: 'emp_month', date: '2025-01-06', shiftId: 'shift_standard', shift: standardShift },
        { employeeId: 'emp_month', date: '2025-01-07', shiftId: 'shift_standard', shift: standardShift },
        { employeeId: 'emp_month', date: '2025-01-08', shiftId: 'shift_standard', shift: standardShift },
      ];
      const punches: PunchRecord[] = [
        { id: 'p1', employeeId: 'emp_month', date: '2025-01-06', checkIn: '09:20', checkOut: '18:00' },
        { id: 'p2', employeeId: 'emp_month', date: '2025-01-07', checkIn: '09:00', checkOut: '17:00' },
      ];
      const leaves: LeaveRequest[] = [
        {
          id: 'l1',
          employeeId: 'emp_month',
          leaveTypeCode: 'sick',
          startTime: '2025-01-08 09:00:00',
          endTime: '2025-01-08 12:00:00',
          unit: 'hour',
          status: 'approved',
          createdAt: '2025-01-01',
          createdBy: 'admin',
        },
      ];

      const summary = engine.generateMonthlySummary({
        employeeId: 'emp_month',
        year: 2025,
        month: 1,
        schedules,
        punches,
        leaves,
        overtimes: [],
        leaveTypes: [sickLeaveType, annualLeaveType],
      });

      expect(summary.dailyAnomalies.length).toBeGreaterThanOrEqual(2);

      const lateDay = summary.dailyAnomalies.find(d => d.date === '2025-01-06');
      expect(lateDay).toBeDefined();
      expect(lateDay?.lateMinutes).toBeGreaterThan(0);

      const earlyDay = summary.dailyAnomalies.find(d => d.date === '2025-01-07');
      expect(earlyDay).toBeDefined();
      expect(earlyDay?.earlyLeaveMinutes).toBeGreaterThan(0);

      const partialLeaveDay = summary.dailyAnomalies.find(d => d.date === '2025-01-08');
      expect(partialLeaveDay).toBeDefined();
      expect(partialLeaveDay?.missingPunch).toBe(true);
      expect(partialLeaveDay?.leaveHours).toBe(3);
      expect(partialLeaveDay?.partialLeaveRemainingHours).toBeCloseTo(5, 1);
    });
  });
});
